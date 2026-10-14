import type { FolderInfo, IndexProgress } from '../../shared/types';
import type { CerebroDb } from '../db/database';
import type { EmbeddingEngine } from '../models/engine';
import { getModel } from '../models/catalog';
import { scanFolder, type ScanOptions } from '../fs/scan';
import { parseFile } from '../parse';
import { chunkText, chunkPages } from '../chunk';

export interface IndexerDeps {
  db: CerebroDb;
  engine: EmbeddingEngine;
  getSettings: () => any;
  onProgress: (p: IndexProgress) => void;
  onFoldersChanged: () => void;
  onStatsChanged: () => void;
}

const EMBED_BATCH = 32;

export class Indexer {
  private state: IndexProgress = {
    running: false,
    paused: false,
    phase: 'idle',
    folderId: null,
    folderName: null,
    filesDone: 0,
    filesTotal: 0,
    chunksDone: 0,
    message: 'Inactivo',
    startedAt: null
  };
  private stopFlag = false;
  private pauseFlag = false;
  private busy = false;
  private rescanTimer: NodeJS.Timeout | null = null;

  constructor(private deps: IndexerDeps) {}

  get progress(): IndexProgress {
    return { ...this.state };
  }

  /* ── Ciclo principal ─────────────────────────────────── */

  async start(opts: { folderIds?: number[]; full?: boolean } = {}): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.stopFlag = false;
    this.pauseFlag = false;
    this.state.running = true;
    this.state.paused = false;
    this.state.startedAt = Date.now();
    this.state.filesDone = 0;
    this.state.chunksDone = 0;
    try {
      await this.runScanPhase(opts.folderIds, opts.full === true);
      if (!this.stopFlag) await this.runEmbedPhase();
      this.refreshFolderStatuses();
      if (!this.stopFlag) {
        this.state.phase = 'idle';
        this.state.message = 'Completado';
        this.deps.onStatsChanged();
      }
    } catch (e: any) {
      this.state.phase = 'error';
      this.state.message = `Error: ${e.message}`;
      this.refreshFolderStatuses();
    } finally {
      this.state.running = false;
      this.state.paused = false;
      this.busy = false;
      this.emit();
    }
  }

  pause(): void {
    if (!this.state.running || this.state.paused) return;
    this.pauseFlag = true;
    this.state.paused = true;
    this.state.message = 'En pausa';
    this.emit();
  }

  async resume(): Promise<void> {
    if (!this.state.running || !this.state.paused) return;
    this.pauseFlag = false;
    this.state.paused = false;
    this.state.message = 'Reanudando…';
    this.emit();
    await this.waitIfPaused();
  }

  stop(): void {
    this.stopFlag = true;
    this.pauseFlag = false;
    this.state.paused = false;
    this.state.message = 'Detenido';
    this.emit();
  }

  private async waitIfPaused(): Promise<void> {
    while (this.pauseFlag && !this.stopFlag) await new Promise((r) => setTimeout(r, 200));
  }

  private set(p: Partial<IndexProgress>): void {
    this.state = { ...this.state, ...p };
    this.emit();
  }

  /* Recalcula el estado de todas las carpetas a partir de sus archivos.
     Sin esto se quedaban en 'scanning' para siempre (solo se escribía al empezar). */
  private refreshFolderStatuses(): void {
    const running = this.state.running && this.state.phase !== 'error';
    for (const f of this.deps.db.listFolders()) {
      if (!f.enabled) continue;
      this.deps.db.setFolderStatus(f.id, this.deps.db.folderStatusFor(f.id, running));
    }
    this.deps.onFoldersChanged();
  }

  private emit(): void {
    this.deps.onProgress(this.state);
  }

  /* ── Fase 1: escaneo + diff de archivos ───────────────── */

  private async runScanPhase(folderIds: number[] | undefined, full: boolean): Promise<void> {
    const folders = this.deps.db.listFolders().filter((f) => f.enabled);
    const targets = folderIds && folderIds.length > 0 ? folders.filter((f) => folderIds.includes(f.id)) : folders;
    if (targets.length === 0) {
      this.set({ phase: 'idle', message: 'No hay carpetas activas' });
      return;
    }

    for (const folder of targets) {
      if (this.stopFlag) return;
      await this.waitIfPaused();
      await this.scanOne(folder, full);
      this.deps.onFoldersChanged();
    }
    this.deps.onStatsChanged();
  }

  private async scanOne(folder: FolderInfo, full: boolean): Promise<void> {
    const s = this.deps.getSettings();
    const opts: ScanOptions = {
      extensions: s.types.extensions as string[],
      maxFileBytes: (s.behavior.maxFileSizeMB as number) * 1024 * 1024,
      excludePatterns: s.behavior.excludePatterns as string[],
      ignoreHidden: s.behavior.ignoreHidden as boolean,
      respectGitignore: s.behavior.respectGitignore as boolean,
      followSymlinks: s.behavior.followSymlinks as boolean
    };

    this.deps.db.setFolderStatus(folder.id, 'scanning');
    this.set({ phase: 'scan', folderId: folder.id, folderName: folder.name, message: `Escaneando ${folder.name}…` });

    let scanned = 0;
    const result = await scanFolder(folder.path, opts, (n) => {
      scanned = n;
      this.set({ message: `Escaneando ${folder.name} · ${n} entradas` });
    });

    this.set({ phase: 'parse', message: `Detectados ${result.files.length} archivos válidos` });

    const existing = new Map(this.deps.db.listFiles(folder.id).map((f) => [f.path, f]));
    const seen = new Set<string>();

    for (const file of result.files) {
      if (this.stopFlag) return;
      seen.add(file.path);
      const prev = existing.get(file.path);
      if (!prev) {
        this.deps.db.upsertFile({ folder_id: folder.id, path: file.path, ext: file.ext, size: file.size, mtime: file.mtime });
      } else if (full || prev.size !== file.size || prev.mtime !== file.mtime) {
        // archivo nuevo o modificado → re-procesar (mantiene estado 'pending')
        this.deps.db.upsertFile({ folder_id: folder.id, path: file.path, ext: file.ext, size: file.size, mtime: file.mtime });
      }
    }

    // archivos eliminados del disco → purgar del índice
    for (const [path, f] of existing) {
      if (!seen.has(path)) this.deps.db.deleteFileRow(f.id);
    }

    this.deps.db.touchFolderScan(folder.id);
    this.deps.db.refreshFolderCounters(folder.id);
    this.deps.db.setFolderStatus(folder.id, this.deps.db.folderStatusFor(folder.id, this.state.running));
  }

  /* ── Fase 2: parseo + chunking (solo archivos pendientes) ── */

  private async runParsePhase(): Promise<void> {
    const s = this.deps.getSettings();
    const spec = { size: s.chunk.size, overlap: s.chunk.overlap, min: s.chunk.min };

    for (;;) {
      if (this.stopFlag) return;
      await this.waitIfPaused();

      const batch = this.pendingParseBatch(16);
      if (batch.length === 0) return;

      for (const file of batch) {
        if (this.stopFlag) return;
        await this.waitIfPaused();

        const parsed = await parseFile(file.path, file.ext);
        if ('skipped' in parsed) {
          this.deps.db.markFileStatus(file.id, 'skipped', parsed.reason);
          continue;
        }
        const chunks =
          parsed.kind === 'pages' ? chunkPages(parsed.pages, spec) : chunkText(parsed.text, spec);
        if (chunks.length === 0) {
          this.deps.db.markFileStatus(file.id, 'skipped', 'sin contenido fragmentable');
          continue;
        }
        this.deps.db.replaceFileChunks(file.id, file.folder_id, chunks);
        this.deps.db.markFileStatus(file.id, 'chunked', null, chunks.length);
      }
      this.deps.db.refreshFolderCounters(batch[0].folder_id);
      this.deps.onStatsChanged();
    }
  }

  private pendingParseBatch(limit: number): { id: number; path: string; ext: string; folder_id: number }[] {
    return this.deps.db.db
      .prepare("SELECT id, path, ext, folder_id FROM files WHERE status = 'pending' ORDER BY id LIMIT ?")
      .all(limit) as any;
  }

  /* ── Fase 3: embeddings (por archivo, reanudable) ─────── */

  private async runEmbedPhase(): Promise<void> {
    const s = this.deps.getSettings();
    const modelId: string = s.embedding.modelId;
    const model = getModel(modelId);
    if (!model) {
      this.set({ phase: 'idle', message: 'Sin modelo de embeddings configurado' });
      return;
    }

    // archivos que fallaron en una pasada anterior (p.ej. modelo no descargado)
    // vuelven a la cola: si no, el cerebro se quedaba sin vectorizar nada
    const retried = this.deps.db.retryErroredFiles();
    if (retried > 0) this.set({ phase: 'parse', message: `Reintentando ${retried} archivos anteriores…` });

    // primero parseamos todo lo pendiente
    this.set({ phase: 'parse', message: 'Extrayendo y fragmentando contenido…' });
    await this.runParsePhase();
    if (this.stopFlag) return;

    const pending = this.deps.db.countChunkedFiles();
    if (pending === 0) {
      this.set({ phase: 'idle', message: 'Todo al día' });
      this.refreshFolderStatuses();
      return;
    }

    this.set({
      phase: 'embed',
      filesTotal: pending,
      filesDone: 0,
      message: `Preparando ${model.id}…`
    });

    // descarga el modelo si aún no está local (con progreso); si no, el primer
    // embeber fallaría y todos los archivos acabarían en estado 'error'
    try {
      await this.deps.engine.ensureModel(model, (ev) => {
        if (ev.status === 'progress' && ev.file) {
          this.set({ message: `Descargando ${model.id} · ${ev.file} ${Math.round(ev.progress ?? 0)}%` });
        } else if (ev.status === 'start') {
          this.set({ message: `Descargando modelo ${model.id}…` });
        }
      });
    } catch (e: any) {
      this.set({ phase: 'error', message: `No se pudo preparar ${model.id}: ${e.message}` });
      return;
    }
    if (this.stopFlag) return;

    let sinceLog = 0;
    for (;;) {
      if (this.stopFlag) return;
      await this.waitIfPaused();

      const files = this.deps.db.pendingEmbedFiles(EMBED_BATCH);
      if (files.length === 0) break;

      for (const file of files) {
        if (this.stopFlag) return;
        await this.waitIfPaused();

        const chunks = this.deps.db.chunksByFile(file.id);
        if (chunks.length === 0) {
          this.deps.db.markFileStatus(file.id, 'ready', null, 0);
          continue;
        }
        try {
          const vectors = await this.deps.engine.embedBatch(
            chunks.map((c) => c.text),
            model
          );
          for (let i = 0; i < chunks.length; i++) {
            this.deps.db.insertVector(chunks[i].id, vectors[i]);
          }
          this.deps.db.markFileStatus(file.id, 'ready', null, chunks.length);
          this.state.chunksDone += chunks.length;
        } catch (e: any) {
          this.deps.db.markFileStatus(file.id, 'error', `embedder: ${e.message}`);
        }

        this.state.filesDone++;
        const elapsed = Date.now() - (this.state.startedAt ?? Date.now());
        if (Date.now() - sinceLog > 2000 || this.state.filesDone === this.state.filesTotal) {
          sinceLog = Date.now();
          const rate = this.state.filesDone / Math.max(1, elapsed / 1000);
          const eta = rate > 0 ? Math.round((this.state.filesTotal - this.state.filesDone) / rate) : 0;
          this.set({
            message: `${this.state.filesDone}/${this.state.filesTotal} archivos · ${this.state.chunksDone} fragmentos · ETA ${formatEta(eta)}`
          });
        }
        this.deps.db.refreshFolderCounters(file.folder_id);
      }
      this.deps.onStatsChanged();
      this.deps.onFoldersChanged();
    }

    this.deps.onStatsChanged();
    this.refreshFolderStatuses();
  }

  /* Recuento rápido de pendientes para el arranque automático */
  hasWorkPending(): boolean {
    return (
      this.deps.db.hasPendingEmbeds() ||
      (this.deps.db.db.prepare("SELECT 1 FROM files WHERE status IN ('pending','error') LIMIT 1").get() != null)
    );
  }
}

function formatEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}
