"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main/index.ts
var import_electron = require("electron");
var import_node_path6 = require("node:path");

// src/main/app.ts
var import_node_fs8 = require("node:fs");

// src/main/config.ts
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var DEFAULTS = {
  server: { port: 7433, token: "", authMode: "bearer", allowLan: false },
  behavior: {
    autoIndex: true,
    respectGitignore: true,
    ignoreHidden: true,
    followSymlinks: false,
    rescanIntervalSec: 120,
    maxFileSizeMB: 10,
    excludePatterns: ["*.min.js", "*.lock", "dist/", "build/", "node_modules/", ".git/"]
  },
  types: {
    preset: "text",
    extensions: [".txt", ".md", ".mdx", ".rst", ".json", ".csv", ".yaml", ".yml", ".toml"]
  },
  embedding: { modelId: null },
  chunk: { size: 512, overlap: 64, min: 48 },
  retrieval: { topK: 8, threshold: 0.35, hybrid: 60 },
  ui: { theme: "dark", animations: true }
};
function deepMerge(base, patch) {
  if (patch === null || patch === void 0 || typeof patch !== "object" || Array.isArray(patch)) {
    return patch === void 0 ? base : patch;
  }
  const src = base;
  const out = Array.isArray(base) ? [...base] : { ...src ?? {} };
  for (const k of Object.keys(patch)) {
    out[k] = src && k in src ? deepMerge(src[k], patch[k]) : patch[k];
  }
  return out;
}
var ConfigStore = class {
  file;
  data;
  constructor(dataDir) {
    if (!(0, import_node_fs.existsSync)(dataDir)) (0, import_node_fs.mkdirSync)(dataDir, { recursive: true });
    this.file = (0, import_node_path.join)(dataDir, "config.json");
    this.data = structuredClone(DEFAULTS);
    if ((0, import_node_fs.existsSync)(this.file)) {
      try {
        const raw = JSON.parse((0, import_node_fs.readFileSync)(this.file, "utf8"));
        this.data = deepMerge(structuredClone(DEFAULTS), raw);
      } catch {
      }
    }
    if (!this.data.server.token) {
      this.data.server.token = "clb_" + (0, import_node_crypto.randomBytes)(16).toString("hex");
      this.save();
    }
  }
  get() {
    return this.data;
  }
  set(patch) {
    this.data = deepMerge(this.data, patch);
    this.save();
    return this.data;
  }
  regenerateToken() {
    this.data.server.token = "clb_" + (0, import_node_crypto.randomBytes)(16).toString("hex");
    this.save();
    return this.data.server.token;
  }
  save() {
    const tmp = this.file + ".tmp";
    (0, import_node_fs.writeFileSync)(tmp, JSON.stringify(this.data, null, 2), "utf8");
    (0, import_node_fs.renameSync)(tmp, this.file);
  }
};
var dataDirFor = (base) => {
  const dir = (0, import_node_path.join)(base, "cerebro");
  if (!(0, import_node_fs.existsSync)(dir)) (0, import_node_fs.mkdirSync)(dir, { recursive: true });
  return dir;
};
var modelsDirFor = (dataDir) => {
  const dir = (0, import_node_path.join)(dataDir, "models");
  if (!(0, import_node_fs.existsSync)(dir)) (0, import_node_fs.mkdirSync)(dir, { recursive: true });
  return dir;
};

// src/main/logger.ts
var MAX = 500;
var Logger = class {
  buf = [];
  listeners = /* @__PURE__ */ new Set();
  nextId = 1;
  log(level, msg) {
    const entry = { id: this.nextId++, ts: Date.now(), level, msg };
    this.buf.push(entry);
    if (this.buf.length > MAX) this.buf.splice(0, this.buf.length - MAX);
    const line = `[${level}] ${msg}`;
    if (level === "ERR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);
    for (const l of this.listeners) l(entry);
  }
  info(msg) {
    this.log("INFO", msg);
  }
  ok(msg) {
    this.log("OK", msg);
  }
  warn(msg) {
    this.log("WARN", msg);
  }
  error(msg) {
    this.log("ERR", msg);
  }
  debug(msg) {
    this.log("DBG", msg);
  }
  tail(limit = 200) {
    return this.buf.slice(-limit);
  }
  clear() {
    this.buf = [];
  }
  subscribe(l) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
};

// src/main/db/database.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"));
var sqliteVec = __toESM(require("sqlite-vec"));
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
var f32 = (arr) => Buffer.from(arr instanceof Float32Array ? arr.buffer.slice(0) : new Float32Array(arr).buffer);
function loadVecExtension(db) {
  const resolved = sqliteVec.getLoadablePath();
  const candidates = [resolved];
  const unpacked = resolved.replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");
  if (unpacked !== resolved) candidates.unshift(unpacked);
  const target = candidates.find((p) => (0, import_node_fs2.existsSync)(p));
  if (!target) {
    throw new Error(`Extensi\xF3n sqlite-vec no encontrada. Rutas probadas: ${candidates.join(" | ")}`);
  }
  db.loadExtension(target);
}
var CerebroDb = class {
  db;
  file;
  dim;
  modelId;
  constructor(opts) {
    this.file = (0, import_node_path2.join)(opts.dataDir, "cerebro.db");
    this.dim = opts.dim;
    this.modelId = opts.modelId;
    const existed = (0, import_node_fs2.existsSync)(this.file);
    this.db = new import_better_sqlite3.default(this.file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
    loadVecExtension(this.db);
    this.migrate(existed);
    this.ensureVecTable();
  }
  migrate(existed) {
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
    if (existed) this.db.pragma("user_version");
  }
  /* Asegura que la tabla vectorial coincide con la dimensión del modelo activo.
     Si cambió el modelo → se reconstruye y los archivos pasan a 'chunked' (a re-embedder). */
  ensureVecTable() {
    const prevDim = this.getMeta("dim");
    const prevModel = this.getMeta("model_id");
    const hasVec = this.tableExists("vec_chunks");
    if (hasVec && prevDim && parseInt(prevDim, 10) !== this.dim) {
      this.db.exec("DROP TABLE vec_chunks");
      this.db.prepare("UPDATE files SET status = 'chunked' WHERE status = 'ready'").run();
      this.db.prepare("DELETE FROM meta WHERE key = ?").run("embedded_chunks");
    }
    if (!this.tableExists("vec_chunks")) {
      this.db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${this.dim}] distance_metric=cosine)`);
    }
    this.setMeta("dim", String(this.dim));
    if (prevModel !== this.modelId) this.setMeta("model_id", this.modelId);
  }
  tableExists(name) {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
    return !!row;
  }
  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value ?? null;
  }
  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  /* ── Carpetas ─────────────────────────────────────────── */
  listFolders() {
    const rows = this.db.prepare("SELECT * FROM folders ORDER BY name COLLATE NOCASE").all();
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      enabled: !!r.enabled,
      status: r.enabled ? r.status : "disabled",
      fileCount: r.file_count,
      totalBytes: r.total_bytes,
      indexedFiles: r.indexed_files,
      addedAt: r.added_at,
      lastScanAt: r.last_scan_at,
      error: r.error
    }));
  }
  addFolder(path, name) {
    this.db.prepare("INSERT INTO folders(path, name, enabled, status, added_at) VALUES (?, ?, 1, 'pending', ?) ON CONFLICT(path) DO UPDATE SET enabled = 1").run(path, name, Date.now());
    return this.folderByPath(path);
  }
  folderByPath(path) {
    const r = this.db.prepare("SELECT * FROM folders WHERE path = ?").get(path);
    if (!r) return null;
    return {
      id: r.id,
      path: r.path,
      name: r.name,
      enabled: !!r.enabled,
      status: r.enabled ? r.status : "disabled",
      fileCount: r.file_count,
      totalBytes: r.total_bytes,
      indexedFiles: r.indexed_files,
      addedAt: r.added_at,
      lastScanAt: r.last_scan_at,
      error: r.error
    };
  }
  setFolderEnabled(id, enabled) {
    this.db.prepare("UPDATE folders SET enabled = ?, status = ? WHERE id = ?").run(enabled ? 1 : 0, enabled ? "pending" : "disabled", id);
  }
  setFolderStatus(id, status, error = null) {
    this.db.prepare("UPDATE folders SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  }
  touchFolderScan(id) {
    this.db.prepare("UPDATE folders SET last_scan_at = ? WHERE id = ?").run(Date.now(), id);
  }
  removeFolder(id) {
    const files = this.db.prepare("SELECT id FROM files WHERE folder_id = ?").all(id);
    for (const f of files) this.deleteFileRow(f.id);
    this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
  }
  refreshFolderCounters(id) {
    this.db.prepare(
      `UPDATE folders SET
           file_count = (SELECT count(*) FROM files WHERE folder_id = @id),
           indexed_files = (SELECT count(*) FROM files WHERE folder_id = @id AND status = 'ready'),
           total_bytes = (SELECT coalesce(sum(size),0) FROM files WHERE folder_id = @id)
         WHERE id = @id`
    ).run({ id });
  }
  /* ── Archivos ─────────────────────────────────────────── */
  fileByPath(path) {
    return this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) ?? null;
  }
  listFiles(folderId) {
    return this.db.prepare("SELECT * FROM files WHERE folder_id = ?").all(folderId);
  }
  upsertFile(row) {
    this.db.prepare(
      `INSERT INTO files(folder_id, path, ext, size, mtime, status) VALUES (@folder_id, @path, @ext, @size, @mtime, 'pending')
         ON CONFLICT(path) DO UPDATE SET folder_id = excluded.folder_id, ext = excluded.ext, size = excluded.size, mtime = excluded.mtime, status = 'pending', error = NULL`
    ).run(row);
    return this.fileByPath(row.path).id;
  }
  markFileStatus(fileId, status, error = null, chunkCount) {
    this.db.prepare("UPDATE files SET status = ?, error = ?, chunk_count = coalesce(?, chunk_count), indexed_at = ? WHERE id = ?").run(status, error, chunkCount ?? null, status === "ready" ? Date.now() : null, fileId);
  }
  deleteFileRow(fileId) {
    const chunkIds = this.db.prepare("SELECT id FROM chunks WHERE file_id = ?").all(fileId).map((c) => c.id);
    this.deleteChunksVectors(chunkIds);
    this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)").run(fileId);
    this.db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  }
  deleteChunksVectors(chunkIds) {
    if (chunkIds.length === 0) return;
    const del = this.db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
    const tx = this.db.transaction((ids) => {
      for (const id of ids) del.run(id);
    });
    tx(chunkIds);
  }
  /* ── Chunks ───────────────────────────────────────────── */
  replaceFileChunks(fileId, folderId, chunks) {
    const oldIds = this.db.prepare("SELECT id FROM chunks WHERE file_id = ?").all(fileId).map((c) => c.id);
    this.deleteChunksVectors(oldIds);
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)").run(fileId);
      this.db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
      const insC = this.db.prepare("INSERT INTO chunks(file_id, folder_id, idx, text, start_off, end_off) VALUES (?,?,?,?,?,?)");
      const insF = this.db.prepare("INSERT INTO chunks_fts(text, chunk_id) VALUES (?, ?)");
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
  pendingEmbedFiles(limit) {
    return this.db.prepare(`SELECT id, path, folder_id FROM files WHERE status = 'chunked' ORDER BY id LIMIT ?`).all(limit);
  }
  chunksByFile(fileId) {
    return this.db.prepare(
      `SELECT c.id, c.file_id, c.folder_id, c.idx, c.text, f.path
         FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.file_id = ? ORDER BY c.idx`
    ).all(fileId);
  }
  countChunkedFiles() {
    return this.db.prepare("SELECT count(*) c FROM files WHERE status = 'chunked'").get().c;
  }
  hasPendingEmbeds() {
    return this.countChunkedFiles() > 0;
  }
  insertVector(chunkId, vec) {
    const id = Math.trunc(Number(chunkId));
    if (!Number.isSafeInteger(id)) throw new Error("chunkId inv\xE1lido");
    this.db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (${id}, ?)`).run(f32(vec));
  }
  getEmbedding(chunkId) {
    const row = this.db.prepare("SELECT embedding FROM vec_chunks WHERE rowid = ?").get(chunkId);
    if (!row) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }
  knn(vec, k) {
    const rows = this.db.prepare("SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ?").all(f32(vec), Math.max(1, Math.trunc(k)));
    return rows.map((r) => ({ chunkId: r.rowid, distance: r.distance }));
  }
  vectorCount() {
    const row = this.db.prepare("SELECT count(*) c FROM vec_chunks").get();
    return row.c;
  }
  ftsSearch(query, k) {
    const terms = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length >= 2).slice(0, 24);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    try {
      const rows = this.db.prepare("SELECT chunk_id, bm25(chunks_fts) AS s FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?").all(ftsQuery, Math.max(1, Math.trunc(k)));
      return rows.map((r) => ({ chunkId: r.chunk_id, score: r.s }));
    } catch {
      return [];
    }
  }
  chunkDetails(chunkIds) {
    const out = /* @__PURE__ */ new Map();
    if (chunkIds.length === 0) return out;
    const placeholders = chunkIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT c.id, c.idx, c.text, c.folder_id, f.path, fo.name AS folder, fo.path AS root
         FROM chunks c
         JOIN files f ON f.id = c.file_id
         JOIN folders fo ON fo.id = c.folder_id
         WHERE c.id IN (${placeholders})`
    ).all(...chunkIds);
    for (const r of rows) {
      out.set(r.id, {
        folderId: r.folder_id,
        path: r.path,
        folder: r.folder,
        root: r.root,
        name: r.path.replace(/\\/g, "/").split("/").pop() ?? r.path,
        ext: (r.path.match(/\.[^.\\/]+$/) ?? [""])[0].toLowerCase(),
        text: r.text,
        idx: r.idx
      });
    }
    return out;
  }
  /* ── Rutas y lectura segura ───────────────────────────── */
  isPathInsideRegisteredFolder(target) {
    const folders = this.listFolders();
    for (const f of folders) {
      const base = f.path.replace(/[/\\]+$/, "");
      if (target === base) return true;
      const rel = target.startsWith(base + "/") || target.startsWith(base + "\\");
      if (rel) return true;
    }
    return false;
  }
  /* ── Estadísticas ─────────────────────────────────────── */
  dashboardStats() {
    const one = (sql, ...args) => this.db.prepare(sql).get(...args) ?? {};
    const folders = one("SELECT count(*) c FROM folders").c;
    const files = one("SELECT count(*) c FROM files").c;
    const chunks = one("SELECT count(*) c FROM chunks").c;
    const bytes = one("SELECT coalesce(sum(total_bytes),0) s FROM folders").s;
    const pending = one("SELECT count(*) c FROM files WHERE status IN ('pending','chunked')").c;
    const indexing = one("SELECT count(*) c FROM folders WHERE status IN ('indexing','scanning')").c;
    const since = Date.now() / 1e3 - 14 * 86400;
    const dailyRaw = this.db.prepare(
      `SELECT date(indexed_at, 'unixepoch', 'localtime') d, count(*) c FROM files
         WHERE indexed_at IS NOT NULL AND indexed_at > ? GROUP BY d ORDER BY d`
    ).all(Math.floor(since));
    const extDistribution = this.db.prepare(
      `SELECT f.ext ext, count(*) c FROM chunks ch JOIN files f ON f.id = ch.file_id
         GROUP BY f.ext ORDER BY c DESC LIMIT 6`
    ).all();
    return {
      folders,
      files,
      chunks,
      bytes,
      pending,
      indexing,
      latencyAvgMs: 0,
      dailyActivity: dailyRaw.map((r) => ({ day: r.d, count: r.c })),
      extDistribution: extDistribution.map((r) => ({ ext: r.ext || "otros", count: r.c }))
    };
  }
  extensionStats() {
    return this.db.prepare("SELECT ext, count(*) count, coalesce(sum(size),0) bytes FROM files GROUP BY ext ORDER BY bytes DESC").all();
  }
  searchLatencyStore = [];
  recordSearchLatency(ms) {
    this.searchLatencyStore.push(ms);
    if (this.searchLatencyStore.length > 50) this.searchLatencyStore.shift();
  }
  avgSearchLatency() {
    if (this.searchLatencyStore.length === 0) return 0;
    return Math.round(this.searchLatencyStore.reduce((a, b) => a + b, 0) / this.searchLatencyStore.length);
  }
  close() {
    this.db.close();
  }
};

// src/main/db/search.ts
var RRF_K = 60;
async function hybridSearch(db, embedQuery, query, opts) {
  const t0 = performance.now();
  const topK = Math.max(1, Math.trunc(opts.topK));
  const wv = Math.min(100, Math.max(0, opts.hybrid)) / 100;
  const wf = 1 - wv;
  const over = Math.max(topK * 6, 60);
  let queryVec = null;
  if (wv > 0) queryVec = await embedQuery(query);
  const scores = /* @__PURE__ */ new Map();
  const sims = /* @__PURE__ */ new Map();
  if (queryVec) {
    const vecHits = db.knn(queryVec, over);
    vecHits.forEach((h, rank) => {
      scores.set(h.chunkId, (scores.get(h.chunkId) ?? 0) + wv / (RRF_K + rank + 1));
      sims.set(h.chunkId, 1 - h.distance);
    });
  }
  if (wf > 0) {
    const ftsHits = db.ftsSearch(query, over);
    ftsHits.forEach((h, rank) => {
      scores.set(h.chunkId, (scores.get(h.chunkId) ?? 0) + wf / (RRF_K + rank + 1));
    });
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const candidateIds = ranked.slice(0, Math.max(topK * 4, over)).map(([id]) => id);
  const details = db.chunkDetails(candidateIds);
  const folderFilter = opts.folderIds && opts.folderIds.length > 0 ? new Set(opts.folderIds) : null;
  const extFilter = opts.exts && opts.exts.length > 0 ? new Set(opts.exts.map((e) => e.toLowerCase())) : null;
  const hits = [];
  for (const [chunkId] of ranked) {
    const d = details.get(chunkId);
    if (!d) continue;
    if (folderFilter && !folderFilter.has(d.folderId)) continue;
    let sim = sims.get(chunkId) ?? null;
    if (sim === null && queryVec) {
      const vec = db.getEmbedding(chunkId);
      if (vec) {
        let dot = 0;
        for (let i = 0; i < queryVec.length; i++) dot += queryVec[i] * vec[i];
        sim = dot;
        sims.set(chunkId, dot);
      }
    }
    if (sim !== null && sim < opts.threshold) continue;
    if (extFilter && !extFilter.has(d.ext)) continue;
    hits.push({
      ruta: d.path,
      carpeta: d.root,
      nombre: d.name,
      ext: d.ext,
      score: Math.round((sim ?? 0) * 1e3) / 1e3,
      chunk: d.idx,
      texto: d.text
    });
    if (hits.length >= topK) break;
  }
  const ms = Math.round(performance.now() - t0);
  db.recordSearchLatency(ms);
  return { query, resultados: hits, ms };
}

// src/main/models/engine.ts
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var EmbeddingEngine = class {
  constructor(modelsDir) {
    this.modelsDir = modelsDir;
  }
  modelsDir;
  pipe = null;
  pipeModelId = null;
  busy = false;
  queue = [];
  isDownloaded(model) {
    const dir = (0, import_node_path3.join)(this.modelsDir, model.repo);
    if (!(0, import_node_fs3.existsSync)(dir)) return false;
    try {
      const names = (0, import_node_fs3.readdirSync)(dir);
      const onnx = names.filter((n) => n.endsWith(".onnx") || n.endsWith(".onnx_data"));
      if (onnx.length === 0) return false;
      const total = onnx.reduce((acc, n) => acc + (0, import_node_fs3.statSync)((0, import_node_path3.join)(dir, n)).size, 0);
      return total > model.downloadMB * 0.5 * 1024 * 1024;
    } catch {
      return false;
    }
  }
  downloadedMB(model) {
    const dir = (0, import_node_path3.join)(this.modelsDir, model.repo);
    if (!(0, import_node_fs3.existsSync)(dir)) return 0;
    try {
      const names = (0, import_node_fs3.readdirSync)(dir);
      return Math.round(
        names.reduce((acc, n) => acc + (0, import_node_fs3.statSync)((0, import_node_path3.join)(dir, n)).size, 0) / (1024 * 1024)
      );
    } catch {
      return 0;
    }
  }
  /* Descarga (o completa) la caché local del modelo, con progreso. */
  async ensureModel(model, onProgress) {
    if (this.isDownloaded(model)) {
      onProgress?.({ modelId: model.id, status: "done", progress: 1 });
      return;
    }
    (0, import_node_fs3.mkdirSync)(this.modelsDir, { recursive: true });
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = this.modelsDir;
    env.allowLocalModels = true;
    onProgress?.({ modelId: model.id, status: "start" });
    const files = await pipeline("feature-extraction", model.repo, {
      dtype: "fp32",
      device: "cpu",
      progress_callback: (p) => {
        if (p.status === "progress") {
          onProgress?.({
            modelId: model.id,
            status: "progress",
            file: p.file,
            progress: p.progress ?? 0,
            loaded: p.loaded ?? 0,
            total: p.total ?? 0
          });
        } else if (p.status === "done") {
          onProgress?.({ modelId: model.id, status: "progress", file: p.file, progress: 100 });
        }
      }
    });
    this.pipe = files;
    this.pipeModelId = model.id;
    onProgress?.({ modelId: model.id, status: "done", progress: 100 });
  }
  async getPipe(model) {
    if (this.pipe && this.pipeModelId === model.id) return this.pipe;
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = this.modelsDir;
    env.allowLocalModels = true;
    this.pipe = await pipeline("feature-extraction", model.repo, { dtype: "fp32", device: "cpu" });
    this.pipeModelId = model.id;
    return this.pipe;
  }
  /* Embedding de un texto (usa el prefijo del modelo si lo define). */
  async embedOne(pipe, model, text) {
    const input = model.prefixes?.passage ? model.prefixes.passage + text : text;
    const out = await pipe(input, { pooling: "mean", normalize: true });
    return new Float32Array(out.data);
  }
  /* Embedding en lote secuencial con ceder al event-loop (mejor en RAM y UI fluida). */
  async embedTexts(texts, model, onBatch) {
    const pipe = await this.getPipe(model);
    const results = [];
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
  async embedQuery(model, query) {
    const pipe = await this.getPipe(model);
    const input = model.prefixes?.query ? model.prefixes.query + query : query;
    const out = await pipe(input, { pooling: "mean", normalize: true });
    return new Float32Array(out.data);
  }
  /* Serializa los embeddings de un lote de chunks en buffers Float32 (para vec0). */
  async embedBatch(texts, model) {
    return this.embedTexts(texts, model);
  }
  get loadedModelId() {
    return this.pipeModelId;
  }
  unload() {
    this.pipe = null;
    this.pipeModelId = null;
  }
};

// src/main/models/catalog.ts
var import_node_os = __toESM(require("node:os"));

// src/main/hardware.ts
var import_node_child_process = require("node:child_process");
function detectGpus() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (gpus) => {
      if (!done) {
        done = true;
        resolve(gpus);
      }
    };
    try {
      (0, import_node_child_process.execFile)(
        "nvidia-smi",
        ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
        { timeout: 3e3, windowsHide: true },
        (err, stdout) => {
          if (err) return finish([]);
          const gpus = [];
          for (const line of stdout.split("\n")) {
            const m = line.match(/^(.*?),\s*(\d+)\s*$/);
            if (m) gpus.push({ name: m[1].trim(), vramMB: parseInt(m[2], 10) });
          }
          finish(gpus);
        }
      );
    } catch {
      finish([]);
    }
    setTimeout(() => finish([]), 4e3);
  });
}

// src/main/models/catalog.ts
var MODEL_CATALOG = [
  {
    id: "multilingual-e5-small",
    label: "multilingual-e5-small",
    repo: "Xenova/multilingual-e5-small",
    dim: 384,
    ctx: 512,
    paramsM: 47,
    downloadMB: 50,
    minRamGB: 4,
    multilingual: true,
    lang: "multiling\xFCe (es/en/\u2026)",
    tier: "ligero",
    prefixes: { query: "query: ", passage: "passage: " },
    desc: "El m\xE1s r\xE1pido y ligero. Multiling\xFCe: buen espa\xF1ol con equipos modestos."
  },
  {
    id: "bge-small-en",
    label: "bge-small-en-v1.5",
    repo: "Xenova/bge-small-en-v1.5",
    dim: 384,
    ctx: 512,
    paramsM: 33,
    downloadMB: 34,
    minRamGB: 4,
    multilingual: false,
    lang: "ing\xE9s",
    tier: "ligero",
    desc: "El m\xE1s peque\xF1o de todos. Solo si trabajas casi en ingl\xE9s."
  },
  {
    id: "multilingual-e5-base",
    label: "multilingual-e5-base",
    repo: "Xenova/multilingual-e5-base",
    dim: 768,
    ctx: 512,
    paramsM: 110,
    downloadMB: 110,
    minRamGB: 8,
    multilingual: true,
    lang: "multiling\xFCe (es/en/\u2026)",
    tier: "equilibrado",
    prefixes: { query: "query: ", passage: "passage: " },
    desc: "Buen equilibrio entre calidad y velocidad en CPU. Multiling\xFCe."
  },
  {
    id: "nomic-embed-text",
    label: "nomic-embed-text-v1",
    repo: "Xenova/nomic-embed-text-v1",
    dim: 768,
    ctx: 2048,
    paramsM: 137,
    downloadMB: 130,
    minRamGB: 8,
    multilingual: false,
    lang: "ing\xE9s",
    tier: "equilibrado",
    desc: "Contexto largo (2048) y buena calidad. Mejor para contenido en ingl\xE9s."
  },
  {
    id: "bge-base-en",
    label: "bge-base-en-v1.5",
    repo: "Xenova/bge-base-en-v1.5",
    dim: 768,
    ctx: 512,
    paramsM: 109,
    downloadMB: 110,
    minRamGB: 8,
    multilingual: false,
    lang: "ing\xE9s",
    tier: "equilibrado",
    desc: "Referente en ingl\xE9s a 768 dims. Multiling\xFCe no: para espa\xF1ol usa e5 o bge-m3."
  },
  {
    id: "multilingual-e5-large",
    label: "multilingual-e5-large",
    repo: "Xenova/multilingual-e5-large",
    dim: 1024,
    ctx: 512,
    paramsM: 560,
    downloadMB: 560,
    minRamGB: 16,
    multilingual: true,
    lang: "multiling\xFCe (es/en/\u2026)",
    tier: "potente",
    prefixes: { query: "query: ", passage: "passage: " },
    desc: "Alta calidad multiling\xFCe (1024 dims). Para equipos con RAM de sobra."
  },
  {
    id: "bge-large-en",
    label: "bge-large-en-v1.5",
    repo: "Xenova/bge-large-en-v1.5",
    dim: 1024,
    ctx: 512,
    paramsM: 335,
    downloadMB: 330,
    minRamGB: 12,
    multilingual: false,
    lang: "ing\xE9s",
    tier: "potente",
    desc: "Alta precisi\xF3n en ingl\xE9s. En espa\xF1ol rinde por debajo de los multiling\xFCes."
  },
  {
    id: "mxbai-embed-large",
    label: "mxbai-embed-large",
    repo: "mixedbread-ai/mxbai-embed-large-v1",
    dim: 1024,
    ctx: 512,
    paramsM: 335,
    downloadMB: 330,
    minRamGB: 12,
    multilingual: false,
    lang: "ing\xE9s",
    tier: "potente",
    desc: "Modelo oficial de Mixedbread (1024 dims). Muy bueno en ingl\xE9s; instrucciones en espa\xF1ol, mejor bge-m3."
  },
  {
    id: "bge-m3",
    label: "bge-m3",
    repo: "Xenova/bge-m3",
    dim: 1024,
    ctx: 8192,
    paramsM: 568,
    downloadMB: 550,
    minRamGB: 16,
    multilingual: true,
    lang: "multiling\xFCe (es/en/\u2026)",
    tier: "maximo",
    desc: "El mejor para espa\xF1ol: multiling\xFCe, 1024 dims y contexto largo. Ideal con GPU o equipo potente."
  }
];
var getModel = (id) => MODEL_CATALOG.find((m) => m.id === id);
async function detectHardware(dataDir) {
  const cpus = import_node_os.default.cpus();
  const gpus = await detectGpus();
  let diskFreeGB = 0;
  try {
    const { statfsSync } = await import("node:fs");
    const st = statfsSync(dataDir);
    diskFreeGB = Math.round(st.bavail * st.bsize / 1024 ** 3 * 10) / 10;
  } catch {
    diskFreeGB = 0;
  }
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: import_node_os.default.hostname(),
    osVersion: `${import_node_os.default.type()} ${import_node_os.default.release()}`,
    cpuModel: cpus[0]?.model?.trim() ?? "desconocido",
    cpuCores: cpus.length,
    cpuSpeedMHz: cpus[0]?.speed ?? 0,
    ramTotalGB: Math.round(import_node_os.default.totalmem() / 1024 ** 3 * 10) / 10,
    ramFreeGB: Math.round(import_node_os.default.freemem() / 1024 ** 3 * 10) / 10,
    gpus,
    dataDir,
    diskFreeGB
  };
}
function recommendModel(hw) {
  const ram = hw.ramTotalGB;
  const cores = hw.cpuCores;
  const vram = hw.gpus.reduce((acc, g) => acc + g.vramMB, 0) / 1024;
  const alternatives = (exclude) => MODEL_CATALOG.filter((m) => m.id !== exclude).map((m) => m.id);
  const pick = (id, tier, reason) => {
    const m = getModel(id);
    return { modelId: m.id, model: m, tier, reason, alternatives: alternatives(m.id) };
  };
  if (vram >= 6 && ram >= 14) {
    return pick("bge-m3", "maximo", `GPU NVIDIA de ${Math.round(vram)} GB y ${ram} GB de RAM: bge-m3 con aceleraci\xF3n por GPU da la m\xE1xima calidad.`);
  }
  if (ram >= 30 && cores >= 8) {
    return pick("bge-m3", "maximo", `Equipo potente (${ram} GB RAM, ${cores} n\xFAcleos): bge-m3 ofrece la mejor b\xFAsqueda en espa\xF1ol.`);
  }
  if (ram >= 22 && cores >= 6) {
    return pick("multilingual-e5-large", "potente", `${ram} GB de RAM y ${cores} n\xFAcleos: multilingual-e5-large aprovecha tu equipo sin GPU.`);
  }
  if (ram >= 14 && cores >= 4) {
    return pick("multilingual-e5-base", "equilibrado", `${ram} GB de RAM y ${cores} n\xFAcleos: multilingual-e5-base da buena calidad sin ralentizar tu equipo.`);
  }
  if (ram >= 7 && cores >= 2) {
    return pick("multilingual-e5-small", "ligero", `${ram} GB de RAM: multilingual-e5-small mantiene la indexaci\xF3n fluida.`);
  }
  return pick("multilingual-e5-small", "ligero", `Equipo modesto (${ram} GB RAM, ${cores} n\xFAcleos): usamos el modelo m\xE1s ligero para no saturar la memoria.`);
}

// src/main/fs/scan.ts
var import_node_fs4 = require("node:fs");
var import_node_path4 = require("node:path");
var import_ignore = __toESM(require("ignore"));
var import_picomatch = __toESM(require("picomatch"));
var DEFAULT_IGNORE_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  ".cache",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  ".terraform"
]);
var extOf = (name) => {
  const i = name.lastIndexOf(".");
  if (i > 0) return name.slice(i).toLowerCase();
  if (i === 0 && name.length > 1) return name.slice(0).toLowerCase();
  return "";
};
async function scanFolder(root, opts, onProgress) {
  const files = [];
  const extMap = /* @__PURE__ */ new Map();
  let dirsIgnored = 0;
  let scanned = 0;
  const extSet = opts.extensions.length > 0 ? new Set(opts.extensions.map((e) => e.toLowerCase())) : null;
  const hasExcludes = opts.excludePatterns.length > 0;
  const matchExclude = hasExcludes ? (0, import_picomatch.default)(opts.excludePatterns.map((p) => p.endsWith("/") ? p + "**" : p), { dot: true, nocase: process.platform === "win32" }) : null;
  const gitIgnores = [];
  if (opts.respectGitignore) {
    try {
      const raw = await import_node_fs4.promises.readFile((0, import_node_path4.join)(root, ".gitignore"), "utf8");
      gitIgnores.push({ base: root, ig: (0, import_ignore.default)().add(raw) });
    } catch {
    }
  }
  const ignoredByGit = (absPath, isDir) => {
    if (!opts.respectGitignore || gitIgnores.length === 0) return false;
    for (const { base, ig } of gitIgnores) {
      const rel = (0, import_node_path4.relative)(base, absPath).split(import_node_path4.sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      if (ig.ignores(isDir ? rel + "/" : rel)) return true;
    }
    return false;
  };
  const walk = async (dir) => {
    let entries;
    try {
      entries = await import_node_fs4.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = (0, import_node_path4.join)(dir, entry.name);
      scanned++;
      if (scanned % 500 === 0) onProgress?.(scanned);
      if (opts.ignoreHidden && entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink() && !opts.followSymlinks) continue;
      let isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) {
        try {
          const st = await import_node_fs4.promises.stat(abs);
          isDir = st.isDirectory();
          if (!st.isFile()) continue;
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) {
          dirsIgnored++;
          continue;
        }
        if (matchExclude && matchExclude(abs.split(import_node_path4.sep).join("/"))) {
          dirsIgnored++;
          continue;
        }
        if (ignoredByGit(abs, true)) {
          dirsIgnored++;
          continue;
        }
        if (opts.respectGitignore) {
          try {
            const raw = await import_node_fs4.promises.readFile((0, import_node_path4.join)(abs, ".gitignore"), "utf8");
            gitIgnores.push({ base: abs, ig: (0, import_ignore.default)().add(raw) });
          } catch {
          }
        }
        await walk(abs);
        continue;
      }
      const effExt = extOf(entry.name) || specialExt(entry.name);
      if (extSet && !extSet.has(effExt)) continue;
      if (matchExclude && matchExclude(abs.split(import_node_path4.sep).join("/"))) continue;
      if (ignoredByGit(abs, false)) continue;
      try {
        const st = await import_node_fs4.promises.stat(abs);
        if (st.size > opts.maxFileBytes) continue;
        if (st.size === 0) continue;
        files.push({ path: abs, ext: effExt, size: st.size, mtime: Math.floor(st.mtimeMs) });
        const key = effExt || "(sin ext)";
        const cur = extMap.get(key) ?? { ext: key, count: 0, bytes: 0 };
        cur.count++;
        cur.bytes += st.size;
        extMap.set(key, cur);
      } catch {
      }
    }
  };
  await walk(root);
  return {
    files,
    extStats: [...extMap.values()].sort((a, b) => b.bytes - a.bytes),
    dirsIgnored
  };
}
var specialExt = (name) => {
  const base = name.toLowerCase();
  if (base.startsWith("makefile")) return ".makefile";
  if (base.startsWith("dockerfile")) return ".dockerfile";
  if (base.startsWith("readme")) return ".md";
  if (base.startsWith("license") || base.startsWith("changelog") || base.startsWith("authors")) return ".txt";
  if (base === "procfile" || base === "gemfile" || base === "cname") return ".txt";
  return "";
};

// src/main/parse/index.ts
var import_node_fs5 = require("node:fs");
var SPECIAL_TEXT = {
  ".makefile": "",
  ".dockerfile": ""
};
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  let nulls = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) nulls++;
  return nulls > 0;
}
function decodeText(buf) {
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 65279) text = text.slice(1);
  return text;
}
async function parseFile(path, ext) {
  if (ext === ".pdf") return parsePdf(path);
  let buf;
  try {
    buf = await import_node_fs5.promises.readFile(path);
  } catch (e) {
    return { skipped: true, reason: `no legible: ${e.message}` };
  }
  if (looksBinary(buf)) return { skipped: true, reason: "contenido binario" };
  const text = decodeText(buf);
  if (!text.trim()) return { skipped: true, reason: "archivo vac\xEDo" };
  void SPECIAL_TEXT;
  return { kind: "text", text };
}
async function parsePdf(path) {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const buf = await import_node_fs5.promises.readFile(path);
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text, totalPages } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map((p) => String(p ?? "").replace(/\s+/g, " ").trim()).filter((p) => p.length > 0);
    if (pages.length === 0 || totalPages === 0) return { skipped: true, reason: "PDF sin texto extra\xEDble (\xBFescaneado?)" };
    return { kind: "pages", pages };
  } catch (e) {
    return { skipped: true, reason: `PDF ilegible: ${e.message}` };
  }
}

// src/main/chunk.ts
var CHARS_PER_TOKEN = 4;
var BOUNDARIES = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""];
function chunkText(text, spec) {
  const target = Math.max(64, Math.round(spec.size * CHARS_PER_TOKEN));
  const overlap = Math.max(0, Math.round(spec.overlap * CHARS_PER_TOKEN));
  const minLen = Math.max(8, Math.round(spec.min * CHARS_PER_TOKEN));
  const out = [];
  if (!text.trim()) return out;
  let pos = 0;
  let guard = 0;
  while (pos < text.length && guard++ < 1e5) {
    let end = Math.min(pos + target, text.length);
    if (end < text.length) {
      const windowFrom = Math.max(pos + Math.floor(target * 0.5), end - Math.max(400, Math.floor(target * 0.3)));
      let cut = -1;
      for (const b of BOUNDARIES) {
        const idx = text.lastIndexOf(b, end);
        if (idx > windowFrom && idx > pos) {
          cut = idx + b.length;
          break;
        }
      }
      if (cut > pos) end = cut;
    }
    let start = pos;
    while (start < end && /\s/.test(text[start])) start++;
    let stop = end;
    while (stop > start && /\s/.test(text[stop - 1])) stop--;
    const seg = text.slice(start, stop);
    const isLast = end >= text.length;
    if (seg.length >= minLen || isLast && seg.length > 0 && out.length === 0) {
      out.push({ text: seg, start, end: stop });
    } else if (isLast && seg.length > 0 && out.length > 0 && seg.length >= Math.floor(minLen / 2)) {
      out.push({ text: seg, start, end: stop });
    }
    if (end >= text.length) break;
    let next = Math.max(end - overlap, pos + 1);
    if (text[next] && !/\s/.test(text[next]) && next > 0 && /\S/.test(text[next - 1])) {
      while (next < text.length && !/[\s\n]/.test(text[next])) next++;
    }
    pos = next;
  }
  return out;
}
function chunkPages(pages, spec) {
  const out = [];
  let offset = 0;
  for (const page of pages) {
    const parts = chunkText(page, spec);
    for (const p of parts) out.push({ text: p.text, start: offset + p.start, end: offset + p.end });
    offset += page.length + 2;
  }
  return out;
}

// src/main/index/indexer.ts
var EMBED_BATCH = 32;
var Indexer = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  state = {
    running: false,
    paused: false,
    phase: "idle",
    folderId: null,
    folderName: null,
    filesDone: 0,
    filesTotal: 0,
    chunksDone: 0,
    message: "Inactivo",
    startedAt: null
  };
  stopFlag = false;
  pauseFlag = false;
  busy = false;
  rescanTimer = null;
  get progress() {
    return { ...this.state };
  }
  /* ── Ciclo principal ─────────────────────────────────── */
  async start(opts = {}) {
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
      if (!this.stopFlag) {
        this.state.phase = "idle";
        this.state.message = "Completado";
        this.deps.onStatsChanged();
      }
    } catch (e) {
      this.state.phase = "error";
      this.state.message = `Error: ${e.message}`;
    } finally {
      this.state.running = false;
      this.state.paused = false;
      this.busy = false;
      this.emit();
    }
  }
  pause() {
    if (!this.state.running || this.state.paused) return;
    this.pauseFlag = true;
    this.state.paused = true;
    this.state.message = "En pausa";
    this.emit();
  }
  async resume() {
    if (!this.state.running || !this.state.paused) return;
    this.pauseFlag = false;
    this.state.paused = false;
    this.state.message = "Reanudando\u2026";
    this.emit();
    await this.waitIfPaused();
  }
  stop() {
    this.stopFlag = true;
    this.pauseFlag = false;
    this.state.paused = false;
    this.state.message = "Detenido";
    this.emit();
  }
  async waitIfPaused() {
    while (this.pauseFlag && !this.stopFlag) await new Promise((r) => setTimeout(r, 200));
  }
  set(p) {
    this.state = { ...this.state, ...p };
    this.emit();
  }
  emit() {
    this.deps.onProgress(this.state);
  }
  /* ── Fase 1: escaneo + diff de archivos ───────────────── */
  async runScanPhase(folderIds, full) {
    const folders = this.deps.db.listFolders().filter((f) => f.enabled);
    const targets = folderIds && folderIds.length > 0 ? folders.filter((f) => folderIds.includes(f.id)) : folders;
    if (targets.length === 0) {
      this.set({ phase: "idle", message: "No hay carpetas activas" });
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
  async scanOne(folder, full) {
    const s = this.deps.getSettings();
    const opts = {
      extensions: s.types.extensions,
      maxFileBytes: s.behavior.maxFileSizeMB * 1024 * 1024,
      excludePatterns: s.behavior.excludePatterns,
      ignoreHidden: s.behavior.ignoreHidden,
      respectGitignore: s.behavior.respectGitignore,
      followSymlinks: s.behavior.followSymlinks
    };
    this.deps.db.setFolderStatus(folder.id, "scanning");
    this.set({ phase: "scan", folderId: folder.id, folderName: folder.name, message: `Escaneando ${folder.name}\u2026` });
    let scanned = 0;
    const result = await scanFolder(folder.path, opts, (n) => {
      scanned = n;
      this.set({ message: `Escaneando ${folder.name} \xB7 ${n} entradas` });
    });
    this.set({ phase: "parse", message: `Detectados ${result.files.length} archivos v\xE1lidos` });
    const existing = new Map(this.deps.db.listFiles(folder.id).map((f) => [f.path, f]));
    const seen = /* @__PURE__ */ new Set();
    for (const file of result.files) {
      if (this.stopFlag) return;
      seen.add(file.path);
      const prev = existing.get(file.path);
      if (!prev) {
        this.deps.db.upsertFile({ folder_id: folder.id, path: file.path, ext: file.ext, size: file.size, mtime: file.mtime });
      } else if (full || prev.size !== file.size || prev.mtime !== file.mtime) {
        this.deps.db.upsertFile({ folder_id: folder.id, path: file.path, ext: file.ext, size: file.size, mtime: file.mtime });
      }
    }
    for (const [path, f] of existing) {
      if (!seen.has(path)) this.deps.db.deleteFileRow(f.id);
    }
    this.deps.db.touchFolderScan(folder.id);
    this.deps.db.refreshFolderCounters(folder.id);
  }
  /* ── Fase 2: parseo + chunking (solo archivos pendientes) ── */
  async runParsePhase() {
    const s = this.deps.getSettings();
    const spec = { size: s.chunk.size, overlap: s.chunk.overlap, min: s.chunk.min };
    for (; ; ) {
      if (this.stopFlag) return;
      await this.waitIfPaused();
      const batch = this.pendingParseBatch(16);
      if (batch.length === 0) return;
      for (const file of batch) {
        if (this.stopFlag) return;
        await this.waitIfPaused();
        const parsed = await parseFile(file.path, file.ext);
        if ("skipped" in parsed) {
          this.deps.db.markFileStatus(file.id, "skipped", parsed.reason);
          continue;
        }
        const chunks = parsed.kind === "pages" ? chunkPages(parsed.pages, spec) : chunkText(parsed.text, spec);
        if (chunks.length === 0) {
          this.deps.db.markFileStatus(file.id, "skipped", "sin contenido fragmentable");
          continue;
        }
        this.deps.db.replaceFileChunks(file.id, file.folder_id, chunks);
        this.deps.db.markFileStatus(file.id, "chunked", null, chunks.length);
      }
      this.deps.db.refreshFolderCounters(batch[0].folder_id);
      this.deps.onStatsChanged();
    }
  }
  pendingParseBatch(limit) {
    return this.deps.db.db.prepare("SELECT id, path, ext, folder_id FROM files WHERE status = 'pending' ORDER BY id LIMIT ?").all(limit);
  }
  /* ── Fase 3: embeddings (por archivo, reanudable) ─────── */
  async runEmbedPhase() {
    const s = this.deps.getSettings();
    const modelId = s.embedding.modelId;
    const model = getModel(modelId);
    if (!model) {
      this.set({ phase: "idle", message: "Sin modelo de embeddings configurado" });
      return;
    }
    this.set({ phase: "parse", message: "Extrayendo y fragmentando contenido\u2026" });
    await this.runParsePhase();
    if (this.stopFlag) return;
    const pending = this.deps.db.countChunkedFiles();
    if (pending === 0) {
      this.set({ phase: "idle", message: "Todo al d\xEDa" });
      return;
    }
    this.set({
      phase: "embed",
      filesTotal: pending,
      filesDone: 0,
      message: `Vectorizando ${pending} archivos con ${model.id}`
    });
    let sinceLog = 0;
    for (; ; ) {
      if (this.stopFlag) return;
      await this.waitIfPaused();
      const files = this.deps.db.pendingEmbedFiles(EMBED_BATCH);
      if (files.length === 0) break;
      for (const file of files) {
        if (this.stopFlag) return;
        await this.waitIfPaused();
        const chunks = this.deps.db.chunksByFile(file.id);
        if (chunks.length === 0) {
          this.deps.db.markFileStatus(file.id, "ready", null, 0);
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
          this.deps.db.markFileStatus(file.id, "ready", null, chunks.length);
          this.state.chunksDone += chunks.length;
        } catch (e) {
          this.deps.db.markFileStatus(file.id, "error", `embedder: ${e.message}`);
        }
        this.state.filesDone++;
        const elapsed = Date.now() - (this.state.startedAt ?? Date.now());
        if (Date.now() - sinceLog > 2e3 || this.state.filesDone === this.state.filesTotal) {
          sinceLog = Date.now();
          const rate = this.state.filesDone / Math.max(1, elapsed / 1e3);
          const eta = rate > 0 ? Math.round((this.state.filesTotal - this.state.filesDone) / rate) : 0;
          this.set({
            message: `${this.state.filesDone}/${this.state.filesTotal} archivos \xB7 ${this.state.chunksDone} fragmentos \xB7 ETA ${formatEta(eta)}`
          });
        }
        this.deps.db.refreshFolderCounters(file.folder_id);
      }
      this.deps.onStatsChanged();
      this.deps.onFoldersChanged();
    }
    this.deps.onStatsChanged();
  }
  /* Recuento rápido de pendientes para el arranque automático */
  hasWorkPending() {
    return this.deps.db.hasPendingEmbeds() || this.deps.db.db.prepare("SELECT 1 FROM files WHERE status = 'pending' LIMIT 1").get() != null;
  }
};
function formatEta(sec) {
  if (!isFinite(sec) || sec <= 0) return "\u2014";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.round(sec % 3600 / 60)}m`;
}

// src/main/server/index.ts
var import_express = __toESM(require("express"));
var import_node_fs6 = require("node:fs");
var import_node_fs7 = require("node:fs");
var import_node_path5 = require("node:path");
var import_zod = require("zod");
var import_mcp = require("@modelcontextprotocol/sdk/server/mcp.js");
var import_streamableHttp = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

// package.json
var package_default = {
  name: "cerebro-local",
  version: "0.2.1",
  description: "Vectoriza tus carpetas y con\xE9ctalas a tus agentes mediante MCP o API \u2014 100% local",
  main: "dist/main/index.js",
  license: "MIT",
  author: "Cerebro Local",
  homepage: "https://github.com/cerebro-local/cerebro-local",
  scripts: {
    build: "node scripts/build.mjs",
    typecheck: "tsc --noEmit",
    smoke: "tsx scripts/smoke.ts",
    "rebuild:electron": "electron-rebuild -f -w better-sqlite3",
    "rebuild:node": "npm rebuild better-sqlite3",
    start: "npm run build && node dist/main/web.js",
    app: "npm run build && npm run rebuild:electron && electron .",
    dist: "npm run build && electron-builder"
  },
  build: {
    appId: "local.cerebro.app",
    productName: "Cerebro Local",
    directories: {
      output: "release"
    },
    files: [
      "dist/**/*",
      "package.json"
    ],
    asarUnpack: [
      "**/node_modules/better-sqlite3/**",
      "**/node_modules/sqlite-vec/**",
      "**/node_modules/sqlite-vec-*/**",
      "**/node_modules/onnxruntime-node/**"
    ],
    win: {
      target: [
        "nsis"
      ]
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true
    },
    linux: {
      target: [
        "AppImage",
        "deb"
      ],
      category: "Utility",
      maintainer: "Cerebro Local <cerebro@localhost>",
      synopsis: "Vectoriza tus carpetas y conectalas a tus agentes mediante MCP o API",
      executableName: "cerebro-local"
    }
  },
  dependencies: {
    "@huggingface/transformers": "^4.3.1",
    "@modelcontextprotocol/sdk": "^1.32.1",
    "better-sqlite3": "^13.0.3",
    chokidar: "^5.0.0",
    "electron-updater": "^6.8.9",
    express: "^5.3.0",
    ignore: "^7.0.12",
    "onnxruntime-node": "^1.30.0",
    picomatch: "^4.0.7",
    "sqlite-vec": "^0.1.9",
    unpdf: "^1.8.1"
  },
  devDependencies: {
    "@electron/rebuild": "^4.2.1",
    "@types/better-sqlite3": "^9.6.0",
    "@types/express": "^5.0.6",
    "@types/node": "^26.6.5",
    "@types/picomatch": "^4.0.3",
    electron: "^44.7.2",
    "electron-builder": "^26.15.3",
    esbuild: "^0.28.2",
    tsx: "^4.23.15",
    typescript: "^7.0.2"
  }
};

// src/shared/version.ts
var APP_VERSION = package_default.version;

// src/main/server/index.ts
function findUiDir() {
  const cands = [
    (0, import_node_path5.join)(__dirname, "../renderer"),
    // empaquetado: dist/main/../renderer
    (0, import_node_path5.join)(__dirname, "../../../dist/renderer")
    // desarrollo con tsx: src/main/server → dist/renderer
  ];
  for (const c of cands) {
    if ((0, import_node_fs6.existsSync)((0, import_node_path5.join)(c, "index.html")) && (0, import_node_fs6.existsSync)((0, import_node_path5.join)(c, "app.js"))) return c;
  }
  return null;
}
var CerebroServer = class {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = (0, import_express.default)();
    this.app.use(import_express.default.json({ limit: "2mb" }));
    this.app.use(this.authMiddleware.bind(this));
    this.registerRoutes();
  }
  ctx;
  app;
  http = null;
  port = 0;
  serverPort = 0;
  /* ── Auth: Bearer token (o desactivada) ──────────────── */
  authMiddleware(req, res, next) {
    if (req.path === "/v1/salud") return next();
    if (!req.path.startsWith("/v1") && !req.path.startsWith("/mcp")) return next();
    const s = this.ctx.getSettings();
    if (s.server.authMode !== "bearer") return next();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-api-key"];
    if (token !== s.server.token) {
      res.status(401).json({ error: "no autorizado: falta o es incorrecto el token (Authorization: Bearer \u2026)" });
      return;
    }
    next();
  }
  async embedQuery(query) {
    const model = getModel(this.ctx.getSettings().embedding.modelId ?? "");
    if (!model) throw new Error("No hay modelo de embeddings configurado");
    return this.ctx.engine.embedQuery(model, query);
  }
  registerRoutes() {
    const app2 = this.app;
    const ctx = this.ctx;
    app2.get("/v1/salud", (_req, res) => {
      res.json({ ok: true, nombre: "Cerebro Local", version: APP_VERSION });
    });
    app2.post("/v1/buscar", async (req, res) => {
      try {
        const body = req.body ?? {};
        const query = String(body.query ?? "").trim();
        if (!query) {
          res.status(400).json({ error: 'Falta el campo "query"' });
          return;
        }
        const s = ctx.getSettings();
        const topK = Math.min(50, Math.max(1, Number(body.top_k ?? s.retrieval.topK)));
        const folderIds = Array.isArray(body.carpetas) && body.carpetas.length > 0 ? this.resolveFolders(body.carpetas) : void 0;
        const result = await hybridSearch(ctx.db, (q) => this.embedQuery(q), query, {
          topK,
          threshold: Number(body.umbral ?? s.retrieval.threshold),
          hybrid: Number(body.hibrido ?? s.retrieval.hybrid),
          folderIds,
          exts: Array.isArray(body.tipos) ? body.tipos : void 0
        });
        res.json(result);
      } catch (e) {
        ctx.logger.error(`API /v1/buscar: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });
    app2.get("/v1/carpetas", (_req, res) => {
      res.json({ carpetas: ctx.db.listFolders() });
    });
    app2.get("/v1/estado", (_req, res) => {
      const st = ctx.db.dashboardStats();
      res.json({
        carpetas: st.folders,
        archivos: st.files,
        fragmentos: st.chunks,
        bytes: st.bytes,
        pendientes: st.pending,
        vectorizando: st.indexing > 0,
        modelo: ctx.getSettings().embedding.modelId,
        progreso: ctx.indexer.progress
      });
    });
    app2.get("/v1/documento", async (req, res) => {
      try {
        const path = String(req.query.path ?? "");
        const offset = Math.max(0, Number(req.query.offset ?? 0));
        const limit = Math.min(2e5, Math.max(100, Number(req.query.limit ?? 4e3)));
        if (!path) {
          res.status(400).json({ error: 'Falta el par\xE1metro "path"' });
          return;
        }
        if (!ctx.db.isPathInsideRegisteredFolder(path)) {
          res.status(403).json({ error: "La ruta no pertenece a ninguna carpeta indexada" });
          return;
        }
        const raw = await import_node_fs7.promises.readFile(path, "utf8").catch(() => null);
        if (raw === null) {
          res.status(404).json({ error: "Archivo no encontrado o ilegible" });
          return;
        }
        res.json({ ruta: path, total: raw.length, offset, contenido: raw.slice(offset, offset + limit) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
    app2.post("/v1/indexar", async (req, res) => {
      const full = req.body?.full === true;
      void ctx.indexer.start({ full });
      res.json({ ok: true, message: full ? "Re-indexaci\xF3n completa iniciada" : "Indexaci\xF3n iniciada" });
    });
    app2.get("/mcp", (_req, res) => {
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32e3, message: "M\xE9todo no disponible: use POST /mcp (Streamable HTTP)" },
        id: null
      });
    });
    const mcpHandler = async (req, res) => {
      try {
        const server = this.buildMcpServer();
        const transport = new import_streamableHttp.StreamableHTTPServerTransport({
          sessionIdGenerator: void 0
          // modo sin sesión: más simple y robusto para clientes locales
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        this.ctx.logger.error(`MCP: ${e.message}`);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: e.message },
            id: null
          });
        }
      }
    };
    app2.post("/mcp", mcpHandler);
    app2.delete("/mcp", mcpHandler);
    const uiDir = findUiDir();
    if (uiDir) {
      app2.use(import_express.default.static(uiDir, { index: "index.html" }));
    }
    app2.post("/bridge", async (req, res) => {
      const body = req.body ?? {};
      if (!this.ctx.dispatch) {
        res.status(500).json({ error: "Puente no disponible en este modo" });
        return;
      }
      const out = await this.ctx.dispatch(String(body.channel ?? ""), Array.isArray(body.args) ? body.args : []);
      res.json(out);
    });
    app2.get("/events", (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write(": conectado\n\n");
      const send2 = (ev) => {
        try {
          res.write(`data: ${JSON.stringify(ev)}

`);
        } catch {
        }
      };
      const unsub = this.ctx.onEvent ? this.ctx.onEvent(send2) : () => {
      };
      const ka = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
        }
      }, 15e3);
      const close = () => {
        clearInterval(ka);
        try {
          unsub();
        } catch {
        }
      };
      req.on("close", close);
      res.on("close", close);
    });
    app2.use((req, res, next) => {
      const p = req.path;
      const isApi = p.startsWith("/v1") || p.startsWith("/mcp") || p.startsWith("/bridge") || p.startsWith("/events");
      if (req.method === "GET" && !isApi && uiDir) {
        res.sendFile((0, import_node_path5.join)(uiDir, "index.html"));
        return;
      }
      next();
    });
    app2.use((_req, res) => {
      res.status(404).json({ error: "Ruta no encontrada. Disponible: /v1/* y /mcp" });
    });
  }
  /* Nombres o rutas de carpeta → ids */
  resolveFolders(refs) {
    const folders = this.ctx.db.listFolders();
    const ids = [];
    for (const r of refs) {
      const key = String(r);
      const f = folders.find((x) => x.id === Number(key) || x.name === key || x.path === key);
      if (f) ids.push(f.id);
    }
    return ids.length > 0 ? ids : void 0;
  }
  buildMcpServer() {
    const ctx = this.ctx;
    const server = new import_mcp.McpServer({ name: "cerebro-local", version: APP_VERSION });
    server.registerTool(
      "buscar",
      {
        description: "Busca fragmentos relevantes en las carpetas indexadas del usuario. Devuelve ruta, puntuaci\xF3n de similitud y texto. \xDAsala SIEMPRE antes de responder preguntas sobre archivos, proyectos, notas o documentos del usuario.",
        inputSchema: {
          query: import_zod.z.string().describe("Consulta en lenguaje natural"),
          top_k: import_zod.z.number().int().min(1).max(30).optional().describe("N\xFAmero de fragmentos (por defecto 8; usa m\xE1s para preguntas amplias)"),
          carpetas: import_zod.z.array(import_zod.z.string()).optional().describe("Filtrar por nombre o ruta de carpeta"),
          tipos: import_zod.z.array(import_zod.z.string()).optional().describe('Filtrar por extensiones, p. ej. [".md", ".pdf"]')
        }
      },
      async ({ query, top_k, carpetas, tipos }) => {
        const s = ctx.getSettings();
        const folderIds = carpetas && carpetas.length > 0 ? this.resolveFolders(carpetas) : void 0;
        const result = await hybridSearch(
          ctx.db,
          (q) => this.embedQuery(q),
          query,
          {
            topK: top_k ?? s.retrieval.topK,
            threshold: s.retrieval.threshold,
            hybrid: s.retrieval.hybrid,
            folderIds,
            exts: tipos
          }
        );
        if (result.resultados.length === 0) {
          return { content: [{ type: "text", text: `Sin resultados para "${query}". No inventes contenido: dilo expl\xEDcitamente.` }] };
        }
        const texto = result.resultados.map(
          (r, i) => `[${i + 1}] ${r.ruta} (similitud ${r.score.toFixed(2)}, fragmento ${r.chunk + 1})
${r.texto}`
        ).join("\n\n---\n\n");
        return { content: [{ type: "text", text: `${result.resultados.length} fragmentos \xB7 ${result.ms} ms

${texto}` }] };
      }
    );
    server.registerTool(
      "listar_carpetas",
      {
        description: "Lista las carpetas vectorizadas del cerebro local y su estado de indexaci\xF3n.",
        inputSchema: {}
      },
      async () => {
        const folders = ctx.db.listFolders();
        const texto = folders.length === 0 ? "No hay carpetas configuradas todav\xEDa." : folders.map(
          (f) => `\u2022 ${f.name} (${f.path}) \u2014 ${f.enabled ? f.status : "desactivada"} \xB7 ${f.fileCount} archivos \xB7 ${f.indexedFiles} indexados`
        ).join("\n");
        return { content: [{ type: "text", text: texto }] };
      }
    );
    server.registerTool(
      "leer_documento",
      {
        description: 'Devuelve el contenido de un documento concreto (o un rango indicando offset/limit). Usa la ruta exacta devuelta por "buscar".',
        inputSchema: {
          path: import_zod.z.string().describe("Ruta absoluta del archivo"),
          offset: import_zod.z.number().int().min(0).optional().describe("Car\xE1cter de inicio"),
          limit: import_zod.z.number().int().min(100).max(2e5).optional().describe("M\xE1ximo de caracteres por lectura")
        }
      },
      async ({ path, offset, limit }) => {
        if (!ctx.db.isPathInsideRegisteredFolder(path)) {
          return { content: [{ type: "text", text: `Denegado: "${path}" no pertenece a ninguna carpeta indexada.` }], isError: true };
        }
        const raw = await import_node_fs7.promises.readFile(path, "utf8").catch(() => null);
        if (raw === null) {
          return { content: [{ type: "text", text: `No se pudo leer "${path}".` }], isError: true };
        }
        const off = offset ?? 0;
        const lim = Math.min(2e5, limit ?? 4e3);
        const slice = raw.slice(off, off + lim);
        return {
          content: [{ type: "text", text: `${path} \xB7 ${raw.length} caracteres totales \xB7 offset ${off}

${slice}` }]
        };
      }
    );
    server.registerTool(
      "estado_index",
      {
        description: "Progreso actual de la vectorizaci\xF3n del cerebro local.",
        inputSchema: {}
      },
      async () => {
        const st = ctx.db.dashboardStats();
        const p = ctx.indexer.progress;
        return {
          content: [
            {
              type: "text",
              text: `Carpetas: ${st.folders} \xB7 Archivos: ${st.files} \xB7 Fragmentos: ${st.chunks}
Pendientes: ${st.pending} \xB7 Modelo: ${ctx.getSettings().embedding.modelId ?? "sin configurar"}
Motor: ${p.running ? `${p.phase} \u2014 ${p.message}` : "inactivo"}`
            }
          ]
        };
      }
    );
    return server;
  }
  get listeningPort() {
    return this.port;
  }
  async start() {
    const s = this.ctx.getSettings();
    const host = s.server.allowLan ? "0.0.0.0" : "127.0.0.1";
    return new Promise((resolve, reject) => {
      this.http = this.app.listen(s.server.port, host, () => {
        const addy = this.http.address();
        this.port = addy && typeof addy === "object" && "port" in addy ? addy.port : 0;
        this.serverPort = this.port;
        this.ctx.logger.ok(`Servidor escuchando en http://${host}:${this.port} (API /v1 \xB7 MCP /mcp)`);
        resolve(this.port);
      });
      this.http.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          this.ctx.logger.warn(`Puerto ${s.server.port} ocupado \xB7 probando puerto libre`);
          this.http.close();
          this.http = this.app.listen(0, host, () => {
            const addy = this.http.address();
            this.port = addy && typeof addy === "object" && "port" in addy ? addy.port : 0;
            this.serverPort = this.port;
            this.ctx.logger.ok(`Servidor escuchando en http://${host}:${this.port} (puerto alternativo)`);
            resolve(this.port);
          });
        } else {
          reject(err);
        }
      });
    });
  }
  async stop() {
    if (!this.http) return;
    await new Promise((resolve) => this.http.close(() => resolve()));
    this.http = null;
  }
};

// src/main/handlers.ts
var coreHandlers = {
  "app:status": (c) => ({ ready: true, hardware: c.hardware, bootError: null }),
  snapshot: (c) => c.snapshot(),
  hardware: (c) => c.hardware,
  "folders:list": (c) => c.db.listFolders(),
  "folders:add": async (c, path) => {
    await c.addFolder(path);
    return c.db.listFolders();
  },
  "folders:remove": (c, id) => {
    c.removeFolder(id);
    return c.db.listFolders();
  },
  "folders:toggle": (c, id, enabled) => {
    c.toggleFolder(id, enabled);
    return c.db.listFolders();
  },
  "index:start": (c, opts) => {
    void c.indexer.start(opts ?? {});
    return c.indexer.progress;
  },
  "index:full": (c) => {
    void c.indexer.start({ full: true });
    return c.indexer.progress;
  },
  "index:pause": (c) => c.indexer.pause(),
  "index:resume": (c) => c.indexer.resume(),
  "index:stop": (c) => c.indexer.stop(),
  "index:progress": (c) => c.indexer.progress,
  "model:catalog": (c) => c.modelCatalog(),
  "model:download": (c, id) => c.downloadModel(id),
  "model:select": (c, id) => c.selectModel(id),
  "settings:get": (c) => c.getSettings(),
  "settings:set": (c, patch) => c.updateSettings(patch),
  "token:regenerate": async (c) => {
    c.config.regenerateToken();
    return c.restartServer();
  },
  "server:restart": (c) => c.restartServer(),
  "server:status": (c) => c.serverStatus(),
  search: (c, query, opts) => c.search(query, opts ?? {}),
  stats: (c) => c.db.dashboardStats(),
  "ext:stats": (c) => c.db.extensionStats(),
  "logs:tail": (c, limit) => c.logger.tail(limit),
  "logs:clear": (c) => {
    c.logger.clear();
    return true;
  }
};
async function dispatchCore(app2, channel, args) {
  const handler = coreHandlers[channel];
  if (!handler) return { error: `Canal desconocido: ${channel}` };
  try {
    return { result: await handler(app2, ...args) };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}

// src/main/app.ts
var CerebroApp = class _CerebroApp {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.dataDir = dataDirFor(baseDir);
    this.modelsDir = modelsDirFor(this.dataDir);
    this.config = new ConfigStore(this.dataDir);
  }
  baseDir;
  dataDir;
  modelsDir;
  config;
  logger = new Logger();
  db;
  engine;
  indexer;
  server;
  hardware;
  listeners = /* @__PURE__ */ new Set();
  serverPort = 0;
  /* Arranque completo del cerebro. `startServer=false` permite el modo headless (tests). */
  static async create(baseDir, opts = {}) {
    const app2 = new _CerebroApp(baseDir);
    const s = app2.config.get();
    app2.hardware = await detectHardware(app2.dataDir);
    app2.logger.info(
      `Equipo: ${app2.hardware.cpuCores} n\xFAcleos \xB7 ${app2.hardware.ramTotalGB} GB RAM` + (app2.hardware.gpus.length > 0 ? ` \xB7 GPU ${app2.hardware.gpus[0].name} (${app2.hardware.gpus[0].vramMB} MB)` : " \xB7 sin GPU dedicada")
    );
    const rec = app2.currentRecommendation();
    if (!s.embedding.modelId) {
      app2.config.set({ embedding: { modelId: rec.modelId } });
      app2.logger.info(`Modelo recomendado para este equipo: ${rec.modelId} (${rec.tier})`);
    }
    const model = getModel(app2.config.get().embedding.modelId ?? rec.modelId);
    app2.db = new CerebroDb({ dataDir: app2.dataDir, dim: model.dim, modelId: model.id });
    app2.engine = new EmbeddingEngine(app2.modelsDir);
    app2.indexer = new Indexer({
      db: app2.db,
      engine: app2.engine,
      getSettings: () => app2.config.get(),
      onProgress: (p) => app2.emit({ type: "index:progress", progress: p }),
      onFoldersChanged: () => app2.emit({ type: "folders:changed" }),
      onStatsChanged: () => app2.emit({ type: "stats:changed" })
    });
    app2.logger.subscribe((entry) => app2.emit({ type: "log", entry }));
    app2.server = new CerebroServer({
      db: app2.db,
      engine: app2.engine,
      indexer: app2.indexer,
      logger: app2.logger,
      getSettings: () => app2.config.get(),
      // la UI web (navegador) usa los mismos canales que el IPC de Electron
      dispatch: (channel, args) => dispatchCore(app2, channel, args),
      onEvent: (cb) => app2.onEvent(cb)
    });
    if (opts.startServer !== false) {
      app2.serverPort = await app2.server.start();
      app2.emit({ type: "server:status", status: app2.serverStatus() });
    }
    return app2;
  }
  /* ── Eventos ─────────────────────────────────────────── */
  onEvent(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(ev) {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
      }
    }
  }
  /* ── Modelos ─────────────────────────────────────────── */
  currentRecommendation() {
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
  activeModelInfo() {
    const id = this.config.get().embedding.modelId;
    const model = id ? getModel(id) : null;
    if (!model) return null;
    return {
      id: model.id,
      dim: model.dim,
      downloaded: this.engine.isDownloaded(model),
      downloadedMB: this.engine.downloadedMB(model),
      ready: this.engine.isDownloaded(model)
    };
  }
  async downloadModel(modelId) {
    const model = getModel(modelId);
    if (!model) return { ok: false, error: `Modelo desconocido: ${modelId}` };
    try {
      await this.engine.ensureModel(
        model,
        (ev) => this.emit({
          type: "model:download",
          modelId: ev.modelId,
          status: ev.status,
          progress: ev.progress ?? 0,
          loaded: ev.loaded ?? 0,
          total: ev.total ?? 0
        })
      );
      return { ok: true };
    } catch (e) {
      this.logger.error(`Descarga de ${modelId} fallida: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }
  /* Cambia el modelo activo. Requiere re-vectorización si cambia la dimensión. */
  async selectModel(modelId) {
    const model = getModel(modelId);
    if (!model) return { ok: false, error: `Modelo desconocido: ${modelId}`, needsDownload: false };
    const prev = this.config.get().embedding.modelId;
    this.config.set({ embedding: { modelId } });
    this.logger.info(`Modelo activo: ${modelId} (antes: ${prev ?? "ninguno"})`);
    if (prev !== modelId) {
      this.db.close();
      this.db = new CerebroDb({ dataDir: this.dataDir, dim: model.dim, modelId: model.id });
      this.engine.unload();
      this.attachDbToServer();
      const vectorCount = this.db.vectorCount();
      if (vectorCount === 0 && this.db.countChunkedFiles() > 0) {
        this.logger.info("El \xEDndice necesita re-vectorizaci\xF3n con el nuevo modelo");
      }
      this.emit({ type: "stats:changed" });
    }
    const needsDownload = !this.engine.isDownloaded(model);
    return { ok: true, needsDownload };
  }
  /* Tras reabrir la DB hay que re-apuntar al servidor y al indexador */
  attachDbToServer() {
    const s = this.config.get();
    this.server.ctx.db = this.db;
    this.indexer.deps.db = this.db;
    void s;
  }
  /* ── Carpetas ────────────────────────────────────────── */
  async addFolder(path) {
    const clean = path.trim();
    if (!clean) throw new Error("La ruta est\xE1 vac\xEDa");
    let st;
    try {
      st = (0, import_node_fs8.statSync)(clean);
    } catch {
      throw new Error(`La ruta no existe: ${clean}`);
    }
    if (!st.isDirectory()) throw new Error(`No es una carpeta: ${clean}`);
    if (this.db.folderByPath(clean)) throw new Error(`La carpeta ya est\xE1 en el cerebro: ${clean}`);
    const name = clean.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? clean;
    this.db.addFolder(clean, name);
    this.logger.info(`Carpeta a\xF1adida: ${clean}`);
    this.emit({ type: "folders:changed" });
    if (this.config.get().behavior.autoIndex) void this.indexer.start({ folderIds: [this.db.folderByPath(clean).id] });
  }
  removeFolder(id) {
    this.db.removeFolder(id);
    this.logger.info(`Carpeta eliminada (id ${id})`);
    this.emit({ type: "folders:changed" });
    this.emit({ type: "stats:changed" });
  }
  toggleFolder(id, enabled) {
    this.db.setFolderEnabled(id, enabled);
    this.logger.info(`Carpeta ${enabled ? "activada" : "desactivada"} (id ${id})`);
    this.emit({ type: "folders:changed" });
    if (enabled && this.config.get().behavior.autoIndex) void this.indexer.start({ folderIds: [id] });
  }
  /* ── Búsqueda (para el playground de la UI) ──────────── */
  async search(query, opts = {}) {
    const s = this.config.get();
    return hybridSearch(this.db, (q) => this.embedQueryPublic(q), query, {
      topK: opts.topK ?? s.retrieval.topK,
      threshold: opts.threshold ?? s.retrieval.threshold,
      hybrid: opts.hybrid ?? s.retrieval.hybrid,
      folderIds: opts.folderIds,
      exts: opts.exts
    });
  }
  async embedQueryPublic(q) {
    const model = getModel(this.config.get().embedding.modelId ?? "");
    if (!model) throw new Error("Sin modelo de embeddings configurado");
    return this.engine.embedQuery(model, q);
  }
  /* ── Servidor ────────────────────────────────────────── */
  serverStatus() {
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
  async restartServer() {
    await this.server.stop();
    this.serverPort = await this.server.start();
    const st = this.serverStatus();
    this.emit({ type: "server:status", status: st });
    return st;
  }
  /* ── Ajustes ─────────────────────────────────────────── */
  getSettings() {
    return this.config.get();
  }
  async updateSettings(patch) {
    const before = this.config.get();
    const after = this.config.set(patch);
    if (after.server.port !== before.server.port || after.server.allowLan !== before.server.allowLan || after.server.authMode !== before.server.authMode) {
      await this.restartServer();
    }
    const typesChanged = JSON.stringify(after.types.extensions) !== JSON.stringify(before.types.extensions);
    const chunkChanged = after.chunk.size !== before.chunk.size || after.chunk.overlap !== before.chunk.overlap || after.chunk.min !== before.chunk.min;
    if (typesChanged) {
      this.logger.info("Filtros de tipos de archivo actualizados \xB7 re-escaneando");
      void this.indexer.start({});
    } else if (chunkChanged) {
      this.logger.info("Par\xE1metros de fragmentaci\xF3n cambiados \xB7 re-procesando");
      this.db.db.prepare("UPDATE files SET status = 'pending' WHERE status IN ('chunked','ready','skipped')").run();
      this.db.db.prepare("DELETE FROM vec_chunks").run();
      this.db.db.prepare("DELETE FROM chunks_fts").run();
      this.db.db.prepare("DELETE FROM chunks").run();
      void this.indexer.start({});
    }
    return after;
  }
  /* ── Snapshot para la UI ─────────────────────────────── */
  async snapshot() {
    return {
      hardware: this.hardware,
      recommendation: this.currentRecommendation(),
      settings: this.config.get(),
      activeModel: this.activeModelInfo(),
      server: this.serverStatus()
    };
  }
  async shutdown() {
    this.indexer.stop();
    await this.server.stop();
    this.db.close();
    this.logger.info("Cerebro detenido");
  }
};

// src/main/index.ts
var win = null;
var cerebro = null;
var readyResolve;
var readyPromise = new Promise((res) => readyResolve = res);
var bootError = null;
function createWindow() {
  win = new import_electron.BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: "#080a0e",
    title: "Cerebro Local",
    autoHideMenuBar: true,
    webPreferences: {
      preload: (0, import_node_path6.join)(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  void win.loadFile((0, import_node_path6.join)(__dirname, "../renderer/index.html"));
  win.on("closed", () => {
    win = null;
  });
}
function send(ev) {
  if (win && !win.isDestroyed()) win.webContents.send("cerebro:event", ev);
}
async function bootstrap() {
  const baseDir = (0, import_node_path6.join)(import_electron.app.getPath("userData"), "data");
  cerebro = await CerebroApp.create(baseDir, { startServer: true });
  cerebro.onEvent(send);
  cerebro.logger.info("Cerebro listo \xB7 la interfaz puede usarlo");
  if (cerebro.getSettings().behavior.autoIndex && cerebro.indexer.hasWorkPending()) {
    cerebro.logger.info("Indexaci\xF3n autom\xE1tica: hay archivos pendientes");
    void cerebro.indexer.start({});
  }
}
async function ready() {
  await readyPromise;
  if (!cerebro) throw new Error(bootError ?? "El cerebro no termin\xF3 de inicializar");
  return cerebro;
}
function handle(channel, fn) {
  import_electron.ipcMain.handle(channel, async (_e, ...args) => {
    try {
      const c = await ready();
      return await fn(c, ...args);
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });
}
var electronExtras = {
  "app:status": () => ({ ready: cerebro !== null, bootError }),
  "folders:pick": async () => {
    const res = await import_electron.dialog.showOpenDialog(win, {
      title: "Selecciona una carpeta para el cerebro",
      properties: ["openDirectory"]
    });
    return res.canceled ? null : res.filePaths[0];
  },
  "open-path": (_c, path) => import_electron.shell.showItemInFolder(path)
};
function registerIpc() {
  const channels = { ...coreHandlers, ...electronExtras };
  for (const [channel, fn] of Object.entries(channels)) handle(channel, fn);
}
import_electron.app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  try {
    await bootstrap();
  } catch (e) {
    bootError = e?.message ?? String(e);
    console.error("Fallo al arrancar el cerebro:", e);
  } finally {
    readyResolve();
  }
  import_electron.app.on("activate", () => {
    if (import_electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
import_electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") import_electron.app.quit();
});
import_electron.app.on("before-quit", (e) => {
  if (cerebro) {
    e.preventDefault();
    void cerebro.shutdown().finally(() => {
      cerebro = null;
      import_electron.app.quit();
    });
  }
});
//# sourceMappingURL=index.js.map
