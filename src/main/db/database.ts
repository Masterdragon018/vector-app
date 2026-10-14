import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DashboardStats, ExtStat, FolderInfo, FolderStatus } from '../../shared/types';

export const f32 = (arr: number[] | Float32Array): Buffer =>
  Buffer.from(arr instanceof Float32Array ? arr.buffer.slice(0) : new Float32Array(arr).buffer);

/* Carga la extensión sqlite-vec.
   En la app empaquetada, `require.resolve` devuelve la ruta dentro de `app.asar`,
   pero `dlopen` es una llamada nativa que no entiende de asar: se encuentra con
   `app.asar` (un fichero) y falla con ENOTDIR ("No es un directorio"), por lo que
   SQLite reintenta con el sufijo y el error aparece como `vec0.so.so`.
   El fichero real vive en `app.asar.unpacked`, así que se prefiere esa ruta. */
export function loadVecExtension(db: Database.Database): void {
  const resolved = sqliteVec.getLoadablePath();
  const candidates = [resolved];
  const unpacked = resolved.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
  if (unpacked !== resolved) candidates.unshift(unpacked);
  const target = candidates.find((p) => existsSync(p));
  if (!target) {
    throw new Error(`Extensión sqlite-vec no encontrada. Rutas probadas: ${candidates.join(' | ')}`);
  }
  db.loadExtension(target);
}

export interface DbOptions {
  dataDir: string;
  dim: number;
  modelId: string;
}

export interface ChunkRow {
  id: number;
  file_id: number;
  folder_id: number;
  idx: number;
  text: string;
}

export interface FileRow {
  id: number;
  folder_id: number;
  path: string;
  ext: string;
  size: number;
  mtime: number;
  hash: string | null;
  status: string;
  chunk_count: number;
}

export class CerebroDb {
  readonly db: Database.Database;
  readonly file: string;
  private dim: number;
  private modelId: string;

  constructor(opts: DbOptions) {
    this.file = join(opts.dataDir, 'cerebro.db');
    this.dim = opts.dim;
    this.modelId = opts.modelId;
    const existed = existsSync(this.file);
    this.db = new Database(this.file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    loadVecExtension(this.db);
    this.migrate(existed);
    this.ensureVecTable();
  }

  private migrate(existed: boolean): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        file_count INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        indexed_files INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        last_scan_at INTEGER,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        path TEXT UNIQUE NOT NULL,
        ext TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
      CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        folder_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        text TEXT NOT NULL,
        start_off INTEGER NOT NULL,
        end_off INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, chunk_id UNINDEXED);
    `);
    if (existed) this.db.pragma('user_version');
  }

  /* Asegura que la tabla vectorial coincide con la dimensión del modelo activo.
     Si cambió el modelo → se reconstruye y los archivos pasan a 'chunked' (a re-embedder). */
  private ensureVecTable(): void {
    const prevDim = this.getMeta('dim');
    const prevModel = this.getMeta('model_id');
    const hasVec = this.tableExists('vec_chunks');
    if (hasVec && prevDim && parseInt(prevDim, 10) !== this.dim) {
      this.db.exec('DROP TABLE vec_chunks');
      this.db.prepare("UPDATE files SET status = 'chunked' WHERE status = 'ready'").run();
      this.db.prepare('DELETE FROM meta WHERE key = ?').run('embedded_chunks');
    }
    if (!this.tableExists('vec_chunks')) {
      this.db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${this.dim}] distance_metric=cosine)`);
    }
    this.setMeta('dim', String(this.dim));
    if (prevModel !== this.modelId) this.setMeta('model_id', this.modelId);
  }

  tableExists(name: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
    return !!row;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /* ── Carpetas ─────────────────────────────────────────── */

  listFolders(): FolderInfo[] {
    const rows = this.db.prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE').all() as any[];
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      enabled: !!r.enabled,
      status: (r.enabled ? r.status : 'disabled') as FolderStatus,
      fileCount: r.file_count,
      totalBytes: r.total_bytes,
      indexedFiles: r.indexed_files,
      addedAt: r.added_at,
      lastScanAt: r.last_scan_at,
      error: r.error
    }));
  }

  addFolder(path: string, name: string): FolderInfo {
    this.db
      .prepare("INSERT INTO folders(path, name, enabled, status, added_at) VALUES (?, ?, 1, 'pending', ?) ON CONFLICT(path) DO UPDATE SET enabled = 1")
      .run(path, name, Date.now());
    return this.folderByPath(path)!;
  }

  folderByPath(path: string): FolderInfo | null {
    const r = this.db.prepare('SELECT * FROM folders WHERE path = ?').get(path) as any;
    if (!r) return null;
    return {
      id: r.id,
      path: r.path,
      name: r.name,
      enabled: !!r.enabled,
      status: (r.enabled ? r.status : 'disabled') as FolderStatus,
      fileCount: r.file_count,
      totalBytes: r.total_bytes,
      indexedFiles: r.indexed_files,
      addedAt: r.added_at,
      lastScanAt: r.last_scan_at,
      error: r.error
    };
  }

  setFolderEnabled(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE folders SET enabled = ?, status = ? WHERE id = ?').run(enabled ? 1 : 0, enabled ? 'pending' : 'disabled', id);
  }

  setFolderStatus(id: number, status: FolderStatus, error: string | null = null): void {
    this.db.prepare('UPDATE folders SET status = ?, error = ? WHERE id = ?').run(status, error, id);
  }

  touchFolderScan(id: number): void {
    this.db.prepare('UPDATE folders SET last_scan_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /* Estado derivado de los archivos de la carpeta. Sin este cálculo las carpetas
     se quedaban eternamente en 'scanning' (solo se escribía ese estado al empezar). */
  folderStatusFor(folderId: number, running: boolean): FolderStatus {
    const r = this.db
      .prepare(
        `SELECT
           sum(CASE WHEN status IN ('pending','chunked') THEN 1 ELSE 0 END) AS todo,
           sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errs,
           count(*) AS total
         FROM files WHERE folder_id = ?`
      )
      .get(folderId) as { todo: number | null; errs: number | null; total: number };
    if (!r || r.total === 0) return 'ready';
    if ((r.todo ?? 0) > 0) return running ? 'indexing' : 'pending';
    if ((r.errs ?? 0) > 0) return 'error';
    return 'ready';
  }

  /* Archivos que fallaron en una pasada anterior (motor caído, modelo no
     descargado…) vuelven a la cola: conservan sus chunks si ya los tienen. */
  retryErroredFiles(): number {
    const a = this.db
      .prepare("UPDATE files SET status = 'chunked', error = NULL WHERE status = 'error' AND chunk_count > 0")
      .run();
    const b = this.db
      .prepare("UPDATE files SET status = 'pending', error = NULL WHERE status = 'error' AND chunk_count = 0")
      .run();
    return a.changes + b.changes;
  }

  removeFolder(id: number): void {
    const files = this.db.prepare('SELECT id FROM files WHERE folder_id = ?').all(id) as { id: number }[];
    for (const f of files) this.deleteFileRow(f.id);
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  }

  refreshFolderCounters(id: number): void {
    this.db
      .prepare(
        `UPDATE folders SET
           file_count = (SELECT count(*) FROM files WHERE folder_id = @id),
           indexed_files = (SELECT count(*) FROM files WHERE folder_id = @id AND status = 'ready'),
           total_bytes = (SELECT coalesce(sum(size),0) FROM files WHERE folder_id = @id)
         WHERE id = @id`
      )
      .run({ id });
  }

  /* ── Archivos ─────────────────────────────────────────── */

  fileByPath(path: string): FileRow | null {
    return (this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined) ?? null;
  }

  listFiles(folderId: number): FileRow[] {
    return this.db.prepare('SELECT * FROM files WHERE folder_id = ?').all(folderId) as FileRow[];
  }

  upsertFile(row: { folder_id: number; path: string; ext: string; size: number; mtime: number }): number {
    this.db
      .prepare(
        `INSERT INTO files(folder_id, path, ext, size, mtime, status) VALUES (@folder_id, @path, @ext, @size, @mtime, 'pending')
         ON CONFLICT(path) DO UPDATE SET folder_id = excluded.folder_id, ext = excluded.ext, size = excluded.size, mtime = excluded.mtime, status = 'pending', error = NULL`
      )
      .run(row);
    return (this.fileByPath(row.path) as FileRow).id;
  }

  markFileStatus(fileId: number, status: string, error: string | null = null, chunkCount?: number): void {
    this.db
      .prepare('UPDATE files SET status = ?, error = ?, chunk_count = coalesce(?, chunk_count), indexed_at = ? WHERE id = ?')
      .run(status, error, chunkCount ?? null, status === 'ready' ? Date.now() : null, fileId);
  }

  deleteFileRow(fileId: number): void {
    const chunkIds = (this.db.prepare('SELECT id FROM chunks WHERE file_id = ?').all(fileId) as { id: number }[]).map((c) => c.id);
    this.deleteChunksVectors(chunkIds);
    this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)').run(fileId);
    this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId); // cascade chunks
  }

  private deleteChunksVectors(chunkIds: number[]): void {
    if (chunkIds.length === 0) return;
    const del = this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) del.run(id);
    });
    tx(chunkIds);
  }

  /* ── Chunks ───────────────────────────────────────────── */

  replaceFileChunks(fileId: number, folderId: number, chunks: { text: string; start: number; end: number }[]): number {
    const oldIds = (this.db.prepare('SELECT id FROM chunks WHERE file_id = ?').all(fileId) as { id: number }[]).map((c) => c.id);
    this.deleteChunksVectors(oldIds);
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)').run(fileId);
      this.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
      const insC = this.db.prepare('INSERT INTO chunks(file_id, folder_id, idx, text, start_off, end_off) VALUES (?,?,?,?,?,?)');
      const insF = this.db.prepare('INSERT INTO chunks_fts(text, chunk_id) VALUES (?, ?)');
      let idx = 0;
      for (const c of chunks) {
        const r = insC.run(fileId, folderId, idx, c.text, c.start, c.end);
        insF.run(c.text, Number(r.lastInsertRowid));
        idx++;
      }
    });
    tx();
    return chunks.length;
  }

  /* Chunks listos para embedder: archivos en estado 'chunked' (procesados por archivo para poder reanudar) */
  pendingEmbedFiles(limit: number): { id: number; path: string; folder_id: number }[] {
    return this.db
      .prepare(`SELECT id, path, folder_id FROM files WHERE status = 'chunked' ORDER BY id LIMIT ?`)
      .all(limit) as any;
  }

  chunksByFile(fileId: number): (ChunkRow & { path: string })[] {
    return this.db
      .prepare(
        `SELECT c.id, c.file_id, c.folder_id, c.idx, c.text, f.path
         FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.file_id = ? ORDER BY c.idx`
      )
      .all(fileId) as any;
  }

  countChunkedFiles(): number {
    return (this.db.prepare("SELECT count(*) c FROM files WHERE status = 'chunked'").get() as any).c;
  }

  hasPendingEmbeds(): boolean {
    return this.countChunkedFiles() > 0;
  }

  insertVector(chunkId: number, vec: number[] | Float32Array): void {
    // sqlite-vec no acepta el rowid como parámetro preparado con better-sqlite3: se interpola como entero seguro
    const id = Math.trunc(Number(chunkId));
    if (!Number.isSafeInteger(id)) throw new Error('chunkId inválido');
    this.db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (${id}, ?)`).run(f32(vec));
  }

  getEmbedding(chunkId: number): Float32Array | null {
    const row = this.db.prepare('SELECT embedding FROM vec_chunks WHERE rowid = ?').get(chunkId) as
      | { embedding: Buffer }
      | undefined;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }

  knn(vec: number[] | Float32Array, k: number): { chunkId: number; distance: number }[] {
    const rows = this.db
      .prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ?')
      .all(f32(vec), Math.max(1, Math.trunc(k))) as { rowid: number; distance: number }[];
    return rows.map((r) => ({ chunkId: r.rowid, distance: r.distance }));
  }

  vectorCount(): number {
    const row = this.db.prepare('SELECT count(*) c FROM vec_chunks').get() as { c: number };
    return row.c;
  }

  ftsSearch(query: string, k: number): { chunkId: number; score: number }[] {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length >= 2)
      .slice(0, 24);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    try {
      const rows = this.db
        .prepare('SELECT chunk_id, bm25(chunks_fts) AS s FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?')
        .all(ftsQuery, Math.max(1, Math.trunc(k))) as { chunk_id: number; s: number }[];
      return rows.map((r) => ({ chunkId: r.chunk_id, score: r.s }));
    } catch {
      return [];
    }
  }

  chunkDetails(chunkIds: number[]): Map<
    number,
    { path: string; folder: string; root: string; folderId: number; name: string; ext: string; text: string; idx: number }
  > {
    const out = new Map();
    if (chunkIds.length === 0) return out;
    const placeholders = chunkIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT c.id, c.idx, c.text, c.folder_id, f.path, fo.name AS folder, fo.path AS root
         FROM chunks c
         JOIN files f ON f.id = c.file_id
         JOIN folders fo ON fo.id = c.folder_id
         WHERE c.id IN (${placeholders})`
      )
      .all(...chunkIds) as any[];
    for (const r of rows) {
      out.set(r.id, {
        folderId: r.folder_id,
        path: r.path,
        folder: r.folder,
        root: r.root,
        name: r.path.replace(/\\/g, '/').split('/').pop() ?? r.path,
        ext: (r.path.match(/\.[^.\\/]+$/) ?? [''])[0].toLowerCase(),
        text: r.text,
        idx: r.idx
      });
    }
    return out;
  }

  /* ── Rutas y lectura segura ───────────────────────────── */

  isPathInsideRegisteredFolder(target: string): boolean {
    const folders = this.listFolders();
    for (const f of folders) {
      const base = f.path.replace(/[/\\]+$/, '');
      if (target === base) return true;
      const rel = target.startsWith(base + '/') || target.startsWith(base + '\\');
      if (rel) return true;
    }
    return false;
  }

  /* ── Estadísticas ─────────────────────────────────────── */

  dashboardStats(): DashboardStats {
    const one = (sql: string, ...args: any[]) => (this.db.prepare(sql).get(...args) as any) ?? {};
    const folders = one('SELECT count(*) c FROM folders').c;
    const files = one('SELECT count(*) c FROM files').c;
    const chunks = one('SELECT count(*) c FROM chunks').c;
    const bytes = one('SELECT coalesce(sum(total_bytes),0) s FROM folders').s;
    const pending = one("SELECT count(*) c FROM files WHERE status IN ('pending','chunked')").c;
    const indexing = one("SELECT count(*) c FROM folders WHERE status IN ('indexing','scanning')").c;

    const since = Date.now() / 1000 - 14 * 86400;
    const dailyRaw = this.db
      .prepare(
        `SELECT date(indexed_at, 'unixepoch', 'localtime') d, count(*) c FROM files
         WHERE indexed_at IS NOT NULL AND indexed_at > ? GROUP BY d ORDER BY d`
      )
      .all(Math.floor(since)) as { d: string; c: number }[];

    const extDistribution = this.db
      .prepare(
        `SELECT f.ext ext, count(*) c FROM chunks ch JOIN files f ON f.id = ch.file_id
         GROUP BY f.ext ORDER BY c DESC LIMIT 6`
      )
      .all() as { ext: string; c: number }[];

    return {
      folders,
      files,
      chunks,
      bytes,
      pending,
      indexing,
      latencyAvgMs: 0,
      dailyActivity: dailyRaw.map((r) => ({ day: r.d, count: r.c })),
      extDistribution: extDistribution.map((r) => ({ ext: r.ext || 'otros', count: r.c }))
    };
  }

  extensionStats(): ExtStat[] {
    return this.db
      .prepare('SELECT ext, count(*) count, coalesce(sum(size),0) bytes FROM files GROUP BY ext ORDER BY bytes DESC')
      .all() as ExtStat[];
  }

  searchLatencyStore: number[] = [];
  recordSearchLatency(ms: number): void {
    this.searchLatencyStore.push(ms);
    if (this.searchLatencyStore.length > 50) this.searchLatencyStore.shift();
  }
  avgSearchLatency(): number {
    if (this.searchLatencyStore.length === 0) return 0;
    return Math.round(this.searchLatencyStore.reduce((a, b) => a + b, 0) / this.searchLatencyStore.length);
  }

  close(): void {
    this.db.close();
  }
}

export const contentHash = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');
