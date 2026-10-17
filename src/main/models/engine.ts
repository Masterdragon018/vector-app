import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComputeDevice, ModelInfo } from '../../shared/types';

export interface DownloadEvent {
  modelId: string;
  status: 'start' | 'progress' | 'done' | 'error';
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

type ProgressCb = (ev: DownloadEvent) => void;

/**
 * Motor de embeddings 100% local sobre ONNX Runtime (transfieres los modelos
 * de Hugging Face al arrancar; sin servidor ni claves).
 * Los ficheros se cachean en <modelsDir>/<repo>/ y se reutilizan entre sesiones.
 */
export class EmbeddingEngine {
  private pipe: any = null;
  private pipeModelId: string | null = null;
  private device: ComputeDevice = 'cpu';

  constructor(private modelsDir: string, preferDevice: ComputeDevice = 'cpu') {
    this.device = preferDevice;
  }

  get computeDevice(): ComputeDevice {
    return this.device;
  }

  isDownloaded(model: ModelInfo): boolean {
    const dir = join(this.modelsDir, model.repo);
    if (!existsSync(dir)) return false;
    try {
      const names = readdirSync(dir);
      const onnx = names.filter((n) => n.endsWith('.onnx') || n.endsWith('.onnx_data'));
      if (onnx.length === 0) return false;
      const total = onnx.reduce((acc, n) => acc + statSync(join(dir, n)).size, 0);
      return total > model.downloadMB * 0.5 * 1024 * 1024;
    } catch {
      return false;
    }
  }

  downloadedMB(model: ModelInfo): number {
    const dir = join(this.modelsDir, model.repo);
    if (!existsSync(dir)) return 0;
    try {
      const names = readdirSync(dir);
      return Math.round(
        names.reduce((acc, n) => acc + statSync(join(dir, n)).size, 0) / (1024 * 1024)
      );
    } catch {
      return 0;
    }
  }

  /* Crea la tubería ONNX en el dispositivo pedido. Si la GPU falla en el último
     momento (driver, VRAM…), se cae a CPU y se recuerda para no reintentar. */
  private async createPipeline(model: ModelInfo, onProgress?: ProgressCb): Promise<any> {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = this.modelsDir;
    env.allowLocalModels = true;
    const opts = {
      dtype: 'fp32' as const,
      device: this.device,
      progress_callback: (p: any) => {
        if (!onProgress) return;
        if (p.status === 'progress') {
          onProgress({
            modelId: model.id,
            status: 'progress',
            file: p.file,
            progress: p.progress ?? 0,
            loaded: p.loaded ?? 0,
            total: p.total ?? 0
          });
        } else if (p.status === 'done') {
          onProgress({ modelId: model.id, status: 'progress', file: p.file, progress: 100 });
        }
      }
    };
    try {
      return await pipeline('feature-extraction', model.repo, opts);
    } catch (e: any) {
      if (this.device === 'cpu') throw e;
      this.device = 'cpu';
      throw new Error(
        `GPU no disponible (${String(e.message).split('\n')[0]}). Reintenta con CPU.`
      );
    }
  }

  /* Descarga (o completa) la caché local del modelo, con progreso. */
  async ensureModel(model: ModelInfo, onProgress?: ProgressCb): Promise<void> {
    if (this.isDownloaded(model)) {
      onProgress?.({ modelId: model.id, status: 'done', progress: 1 });
      return;
    }
    mkdirSync(this.modelsDir, { recursive: true });
    onProgress?.({ modelId: model.id, status: 'start' });

    // la descarga siempre en CPU: solo queremos los ficheros en caché
    const prevDevice = this.device;
    this.device = 'cpu';
    try {
      this.pipe = await this.createPipeline(model, onProgress);
      this.pipeModelId = model.id;
    } finally {
      this.device = prevDevice;
    }
    onProgress?.({ modelId: model.id, status: 'done', progress: 100 });
  }

  /* Carga el modelo en memoria (calentamiento): evita el coste de la primera
     búsqueda y da tiempo a que GPU/CPU esté lista antes de que lleguenconsultas. */
  async warmup(model: ModelInfo): Promise<void> {
    await this.getPipe(model);
    // una pasada real descubre errores de runtime (driver, VRAM insuficiente…)
    await this.embedQuery(model, 'cerebro listo');
  }

  private async getPipe(model: ModelInfo): Promise<any> {
    if (this.pipe && this.pipeModelId === model.id) return this.pipe;
    try {
      this.pipe = await this.createPipeline(model);
    } catch (e: any) {
      if (this.device === 'cpu') throw e;
      // reintento en CPU: preferencia de GPU, pero la búsqueda nunca falla por esto
      this.device = 'cpu';
      this.pipe = await this.createPipeline(model);
    }
    this.pipeModelId = model.id;
    return this.pipe;
  }

  /* Embedding de un texto (usa el prefijo del modelo si lo define). */
  private async embedOne(pipe: any, model: ModelInfo, text: string): Promise<Float32Array> {
    const input = model.prefixes?.passage ? model.prefixes.passage + text : text;
    const out = await pipe(input, { pooling: 'mean', normalize: true });
    return new Float32Array(out.data as Float32Array);
  }

  /* Embedding en lote secuencial con ceder al event-loop (mejor en RAM y UI fluida). */
  async embedTexts(texts: string[], model: ModelInfo, onBatch?: (done: number, total: number) => void): Promise<Float32Array[]> {
    const pipe = await this.getPipe(model);
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      const v = await this.embedOne(pipe, model, texts[i]);
      results.push(new Float32Array(v));
      if (onBatch && (i + 1) % 8 === 0) {
        onBatch(i + 1, texts.length);
        await new Promise((r) => setImmediate(r));
      }
    }
    onBatch?.(texts.length, texts.length);
    return results;
  }

  async embedQuery(model: ModelInfo, query: string): Promise<Float32Array> {
    const pipe = await this.getPipe(model);
    const input = model.prefixes?.query ? model.prefixes.query + query : query;
    const out = await pipe(input, { pooling: 'mean', normalize: true });
    return new Float32Array(out.data as Float32Array);
  }

  /* Serializa los embeddings de un lote de chunks en buffers Float32 (para vec0). */
  async embedBatch(texts: string[], model: ModelInfo): Promise<Float32Array[]> {
    return this.embedTexts(texts, model);
  }

  get loadedModelId(): string | null {
    return this.pipeModelId;
  }

  unload(): void {
    this.pipe = null;
    this.pipeModelId = null;
  }

  /* Descarga y calienta el modelo en segundo plano; errores ya gestionados por el llamante. */
  async preload(model: ModelInfo, onProgress?: ProgressCb): Promise<void> {
    await this.ensureModel(model, onProgress);
    await this.warmup(model);
  }
}

/* Guarda un marcador para saber qué modelo está activo en el índice */
export const writeModelIndexMarker = (modelsDir: string, modelId: string): void => {
  writeFileSync(join(modelsDir, '.active-model'), modelId, 'utf8');
};
