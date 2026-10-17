import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigStore, dataDirFor, modelsDirFor } from './config';
import { Logger } from './logger';
import { CerebroDb } from './db/database';
import { hybridSearch } from './db/search';
import { EmbeddingEngine } from './models/engine';
import { detectHardware, getModel, recommendModel, MODEL_CATALOG } from './models/catalog';
import { Indexer } from './index/indexer';
import { CerebroServer } from './server';
import { ClientRegistry } from './clients';
import { dispatchCore } from './handlers';
import type {
  ActiveModel,
  ClientInfo,
  ComputeDevice,
  CerebroEvent,
  HardwareInfo,
  ModelRecommendation,
  SearchResult,
  ServerStatus,
  Settings
} from '../shared/types';

export interface CerebroSnapshot {
  hardware: HardwareInfo;
  recommendation: ModelRecommendation;
  settings: Settings;
  activeModel: ActiveModel | null;
  server: ServerStatus;
  device: ComputeDevice;
}

export class CerebroApp {
  readonly dataDir: string;
  readonly modelsDir: string;
  readonly config: ConfigStore;
  readonly logger = new Logger();
  readonly clients = new ClientRegistry();
  db!: CerebroDb;
  engine!: EmbeddingEngine;
  indexer!: Indexer;
  server!: CerebroServer;
  hardware!: HardwareInfo;
  private listeners = new Set<(ev: CerebroEvent) => void>();
  private serverPort = 0;

  private constructor(readonly baseDir: string) {
    this.dataDir = dataDirFor(baseDir);
    this.modelsDir = modelsDirFor(this.dataDir);
    this.config = new ConfigStore(this.dataDir);
  }

  /* Arranque completo del cerebro. `startServer=false` permite el modo headless (tests). */
  static async create(baseDir: string, opts: { startServer?: boolean } = {}): Promise<CerebroApp> {
    const app = new CerebroApp(baseDir);
    const s = app.config.get();

    app.hardware = await detectHardware(app.dataDir);
    app.logger.info(
      `Equipo: ${app.hardware.cpuCores} núcleos · ${app.hardware.ramTotalGB} GB RAM` +
        (app.hardware.gpus.length > 0 ? ` · GPU ${app.hardware.gpus[0].name} (${app.hardware.gpus[0].vramMB} MB)` : ' · sin GPU dedicada')
    );

    const rec = app.currentRecommendation();
    // migración: si el modelo configurado ya no existe en el catálogo (p. ej. se
    // redujo a 3 modelos), se sustituye por el recomendado para este equipo
    let modelId = s.embedding.modelId;
    if (modelId && !getModel(modelId)) {
      app.logger.warn(`El modelo «${modelId}» ya no está disponible · usando ${rec.modelId}`);
      modelId = null;
    }
    if (!modelId) {
      app.config.set({ embedding: { modelId: rec.modelId } });
      app.logger.info(`Modelo recomendado para este equipo: ${rec.modelId} (${rec.tier})`);
      modelId = rec.modelId;
    }

    const model = getModel(modelId!)!;
    app.db = new CerebroDb({ dataDir: app.dataDir, dim: model.dim, modelId: model.id });

    // GPU: si hay gráfica disponible, los embeddings van a la GPU cuando sea posible:
    //   · Linux x64 → CUDA (runtime local vía scripts/setup-gpu.mjs, ~14× más rápido)
    //   · Windows   → DirectML (EP incluido en onnxruntime-node para win32, usa la RTX/GTX vía DirectX)
    //   · si falla el EP de GPU, el motor cae a CPU automáticamente.
    const hasGpu = app.hardware.gpus.length > 0;
    const preferDevice: ComputeDevice =
      process.platform === 'linux' && process.arch === 'x64' && hasGpu
        ? 'cuda'
        : process.platform === 'win32' && hasGpu
          ? 'dml'
          : 'cpu';
    app.engine = new EmbeddingEngine(app.modelsDir, preferDevice);
    app.indexer = new Indexer({
      db: app.db,
      engine: app.engine,
      getSettings: () => app.config.get(),
      onProgress: (p) => app.emit({ type: 'index:progress', progress: p }),
      onFoldersChanged: () => app.emit({ type: 'folders:changed' }),
      onStatsChanged: () => app.emit({ type: 'stats:changed' })
    });
    app.logger.subscribe((entry) => app.emit({ type: 'log', entry }));

    app.server = new CerebroServer({
      db: app.db,
      engine: app.engine,
      indexer: app.indexer,
      logger: app.logger,
      getSettings: () => app.config.get(),
      clients: app.clients,
      onClientsChanged: () => app.emit({ type: 'clients:changed' }),
      // la UI web (navegador) usa los mismos canales que el IPC de Electron
      dispatch: (channel, args) => dispatchCore(app, channel, args),
      onEvent: (cb) => app.onEvent(cb as (ev: CerebroEvent) => void)
    });

    if (opts.startServer !== false) {
      app.serverPort = await app.server.start();
      app.emit({ type: 'server:status', status: app.serverStatus() });
    }
    return app;
  }

  /* Precarga del modelo de embeddings: siempre al arrancar, pase lo que pase.
     Descarga la caché si falta y calienta la tubería (CPU o GPU) para que la
     primera búsqueda del usuario no pague el coste de carga. No bloquea el
     arranque: se lanza en segundo plano y su progreso va al registro. */
  async preloadModel(): Promise<void> {
    const model = getModel(this.config.get().embedding.modelId ?? '');
    if (!model) return;
    const t0 = Date.now();
    const deviceLabel = this.engine.computeDevice === 'cpu' ? 'CPU' : 'GPU';
    try {
      this.logger.info(`Preparando modelo ${model.id} (${deviceLabel})…`);
      await this.engine.preload(model, (ev) => {
        if (ev.status === 'progress' && ev.file) {
          this.logger.info(`Descargando ${model.id} · ${ev.file} ${Math.round(ev.progress ?? 0)}%`);
        } else if (ev.status === 'start') {
          this.logger.info(`Descargando modelo ${model.id}…`);
        }
      });
      this.logger.ok(
        `Modelo ${model.id} listo en ${((Date.now() - t0) / 1000).toFixed(1)} s · embeddings en ${
          this.engine.computeDevice === 'cuda'
            ? 'GPU (CUDA)'
            : this.engine.computeDevice === 'dml'
              ? 'GPU (DirectML)'
              : 'CPU'
        }`
      );
    } catch (e: any) {
      // un fallo de precarga no debe tumbar el arranque: el indexador lo reintentará
      this.logger.warn(`No se pudo precargar el modelo: ${e.message}`);
    }
  }

  /* ── Eventos ─────────────────────────────────────────── */

  onEvent(cb: (ev: CerebroEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(ev: CerebroEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* listener caído */
      }
    }
  }

  /* ── Modelos ─────────────────────────────────────────── */

  currentRecommendation(): ModelRecommendation {
    return recommendModel(this.hardware);
  }

  modelCatalog() {
    return MODEL_CATALOG.map((m) => ({
      ...m,
      downloaded: this.engine.isDownloaded(m),
      downloadedMB: this.engine.downloadedMB(m),
      active: this.config.get().embedding.modelId === m.id
    }));
  }

  activeModelInfo(): ActiveModel | null {
    const id = this.config.get().embedding.modelId;
    const model = id ? getModel(id) : null;
    if (!model) return null;
    return {
      id: model.id,
      dim: model.dim,
      downloaded: this.engine.isDownloaded(model),
      downloadedMB: this.engine.downloadedMB(model),
      ready: this.engine.isDownloaded(model),
      device: this.engine.computeDevice
    };
  }

  /* ── Clientes ───────────────────────────────────────── */

  listClients(): ClientInfo[] {
    return this.clients.list();
  }

  async downloadModel(modelId: string): Promise<{ ok: boolean; error?: string }> {
    const model = getModel(modelId);
    if (!model) return { ok: false, error: `Modelo desconocido: ${modelId}` };
    try {
      await this.engine.ensureModel(model, (ev) =>
        this.emit({
          type: 'model:download',
          modelId: ev.modelId,
          status: ev.status,
          progress: ev.progress ?? 0,
          loaded: ev.loaded ?? 0,
          total: ev.total ?? 0
        })
      );
      return { ok: true };
    } catch (e: any) {
      this.logger.error(`Descarga de ${modelId} fallida: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /* Cambia el modelo activo. Requiere re-vectorización si cambia la dimensión. */
  async selectModel(modelId: string): Promise<{ ok: boolean; error?: string; needsDownload: boolean }> {
    const model = getModel(modelId);
    if (!model) return { ok: false, error: `Modelo desconocido: ${modelId}`, needsDownload: false };
    const prev = this.config.get().embedding.modelId;
    this.config.set({ embedding: { modelId } });
    this.logger.info(`Modelo activo: ${modelId} (antes: ${prev ?? 'ninguno'})`);

    if (prev !== modelId) {
      // si cambia la dimensión, db.re abre la tabla vec con la nueva dimensión y marca para re-vectorizar
      this.db.close();
      this.db = new CerebroDb({ dataDir: this.dataDir, dim: model.dim, modelId: model.id });
      this.engine.unload();
      this.attachDbToServer();
      const vectorCount = this.db.vectorCount();
      if (vectorCount === 0 && this.db.countChunkedFiles() > 0) {
        this.logger.info('El índice necesita re-vectorización con el nuevo modelo');
      }
      this.emit({ type: 'stats:changed' });
    }
    const needsDownload = !this.engine.isDownloaded(model);
    return { ok: true, needsDownload };
  }

  /* Tras reabrir la DB hay que re-apuntar al servidor y al indexador */
  private attachDbToServer(): void {
    const s = this.config.get();
    (this.server as any).ctx.db = this.db;
    (this.indexer as any).deps.db = this.db;
    void s;
  }

  /* ── Carpetas ────────────────────────────────────────── */

  async addFolder(path: string): Promise<void> {
    const clean = path.trim();
    if (!clean) throw new Error('La ruta está vacía');
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(clean);
    } catch {
      throw new Error(`La ruta no existe: ${clean}`);
    }
    if (!st.isDirectory()) throw new Error(`No es una carpeta: ${clean}`);
    if (this.db.folderByPath(clean)) throw new Error(`La carpeta ya está en el cerebro: ${clean}`);

    const name = clean.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? clean;
    this.db.addFolder(clean, name);
    this.logger.info(`Carpeta añadida: ${clean}`);
    this.emit({ type: 'folders:changed' });
    if (this.config.get().behavior.autoIndex) void this.indexer.start({ folderIds: [this.db.folderByPath(clean)!.id] });
  }

  removeFolder(id: number): void {
    this.db.removeFolder(id);
    this.logger.info(`Carpeta eliminada (id ${id})`);
    this.emit({ type: 'folders:changed' });
    this.emit({ type: 'stats:changed' });
  }

  toggleFolder(id: number, enabled: boolean): void {
    this.db.setFolderEnabled(id, enabled);
    this.logger.info(`Carpeta ${enabled ? 'activada' : 'desactivada'} (id ${id})`);
    this.emit({ type: 'folders:changed' });
    if (enabled && this.config.get().behavior.autoIndex) void this.indexer.start({ folderIds: [id] });
  }

  /* ── Búsqueda (para el playground de la UI) ──────────── */

  async search(query: string, opts: Partial<{ topK: number; threshold: number; hybrid: number; folderIds: number[]; exts: string[] }> = {}): Promise<SearchResult> {
    const s = this.config.get();
    return hybridSearch(this.db, (q) => this.embedQueryPublic(q), query, {
      topK: opts.topK ?? s.retrieval.topK,
      threshold: opts.threshold ?? s.retrieval.threshold,
      hybrid: opts.hybrid ?? s.retrieval.hybrid,
      folderIds: opts.folderIds,
      exts: opts.exts
    });
  }

  private async embedQueryPublic(q: string): Promise<Float32Array> {
    const model = getModel(this.config.get().embedding.modelId ?? '');
    if (!model) throw new Error('Sin modelo de embeddings configurado');
    return this.engine.embedQuery(model, q);
  }

  /* ── Servidor ────────────────────────────────────────── */

  serverStatus(): ServerStatus {
    const s = this.config.get();
    const port = this.serverPort || s.server.port;
    return {
      running: this.serverPort > 0,
      port,
      url: `http://127.0.0.1:${port}`,
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      authMode: s.server.authMode,
      token: s.server.token,
      allowLan: s.server.allowLan
    };
  }

  async restartServer(): Promise<ServerStatus> {
    await this.server.stop();
    this.serverPort = await this.server.start();
    const st = this.serverStatus();
    this.emit({ type: 'server:status', status: st });
    return st;
  }

  /* ── Ajustes ─────────────────────────────────────────── */

  getSettings(): Settings {
    return this.config.get();
  }

  async updateSettings(patch: any): Promise<Settings> {
    const before = this.config.get();
    const after = this.config.set(patch);

    // cambios que obligan a reiniciar el servidor
    if (after.server.port !== before.server.port || after.server.allowLan !== before.server.allowLan || after.server.authMode !== before.server.authMode) {
      await this.restartServer();
    }

    // cambios que obligan a re-indexar
    const typesChanged = JSON.stringify(after.types.extensions) !== JSON.stringify(before.types.extensions);
    const chunkChanged =
      after.chunk.size !== before.chunk.size || after.chunk.overlap !== before.chunk.overlap || after.chunk.min !== before.chunk.min;

    if (typesChanged) {
      this.logger.info('Filtros de tipos de archivo actualizados · re-escaneando');
      void this.indexer.start({});
    } else if (chunkChanged) {
      this.logger.info('Parámetros de fragmentación cambiados · re-procesando');
      this.db.db.prepare("UPDATE files SET status = 'pending' WHERE status IN ('chunked','ready','skipped')").run();
      this.db.db.prepare('DELETE FROM vec_chunks').run();
      this.db.db.prepare('DELETE FROM chunks_fts').run();
      this.db.db.prepare('DELETE FROM chunks').run();
      void this.indexer.start({});
    }
    return after;
  }

  /* ── Snapshot para la UI ─────────────────────────────── */

  async snapshot(): Promise<CerebroSnapshot> {
    return {
      hardware: this.hardware,
      recommendation: this.currentRecommendation(),
      settings: this.config.get(),
      activeModel: this.activeModelInfo(),
      server: this.serverStatus(),
      device: this.engine.computeDevice
    };
  }

  async shutdown(): Promise<void> {
    this.indexer.stop();
    await this.server.stop();
    this.db.close();
    this.logger.info('Cerebro detenido');
  }
}

export const defaultBaseDir = (): string => process.env.CEREBRO_HOME ?? join(process.cwd(), '.cerebro-data');
