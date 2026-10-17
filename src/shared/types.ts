/* Tipos compartidos entre proceso main, preload y renderer */

export type FolderStatus = 'pending' | 'scanning' | 'indexing' | 'ready' | 'error' | 'disabled';

export interface FolderInfo {
  id: number;
  path: string;
  name: string;
  enabled: boolean;
  status: FolderStatus;
  fileCount: number;
  totalBytes: number;
  indexedFiles: number;
  addedAt: number;
  lastScanAt: number | null;
  error: string | null;
}

export interface ExtStat {
  ext: string;
  count: number;
  bytes: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  repo: string;
  dim: number;
  ctx: number;
  paramsM: number;
  downloadMB: number;
  minRamGB: number;
  multilingual: boolean;
  lang: string;
  tier: 'ligero' | 'normal' | 'potente';
  prefixes?: { query?: string; passage?: string };
  desc: string;
}

export interface GpuInfo {
  name: string;
  vramMB: number;
}

export interface HardwareInfo {
  platform: NodeJS.Platform;
  arch: string;
  hostname: string;
  osVersion: string;
  cpuModel: string;
  cpuCores: number;
  cpuSpeedMHz: number;
  ramTotalGB: number;
  ramFreeGB: number;
  gpus: GpuInfo[];
  dataDir: string;
  diskFreeGB: number;
}

export interface ModelRecommendation {
  modelId: string;
  model: ModelInfo;
  reason: string;
  tier: 'ligero' | 'normal' | 'potente';
  alternatives: string[];
}

/* Dispositivo donde se ejecutan los embeddings */
export type ComputeDevice = 'cuda' | 'dml' | 'cpu';

export interface ActiveModel {
  id: string;
  dim: number;
  downloaded: boolean;
  downloadedMB: number;
  ready: boolean;
  device: ComputeDevice;
}

/* Cliente que ha conectado al servicio (agente MCP o app vía API REST) */
export interface ClientInfo {
  key: string;
  kind: 'MCP' | 'API';
  name: string;
  ip: string;
  userAgent: string;
  requests: number;
  firstSeen: number;
  lastSeen: number;
  lastTool: string | null;
  active: boolean;
}

export interface SearchHit {
  ruta: string;
  carpeta: string;
  nombre: string;
  ext: string;
  score: number;
  chunk: number;
  texto: string;
}

export interface SearchResult {
  query: string;
  resultados: SearchHit[];
  ms: number;
}

export interface IndexProgress {
  running: boolean;
  paused: boolean;
  phase: 'idle' | 'scan' | 'parse' | 'embed' | 'download' | 'reembed' | 'error';
  folderId: number | null;
  folderName: string | null;
  filesDone: number;
  filesTotal: number;
  chunksDone: number;
  message: string;
  startedAt: number | null;
}

export interface ServerStatus {
  running: boolean;
  port: number;
  url: string;
  mcpUrl: string;
  authMode: 'bearer' | 'none';
  token: string;
  allowLan: boolean;
}

export interface DashboardStats {
  folders: number;
  files: number;
  chunks: number;
  bytes: number;
  pending: number;
  indexing: number;
  latencyAvgMs: number;
  dailyActivity: { day: string; count: number }[];
  extDistribution: { ext: string; count: number }[];
}

export interface LogEntry {
  id: number;
  ts: number;
  level: 'INFO' | 'OK' | 'WARN' | 'ERR' | 'DBG';
  msg: string;
}

export type Settings = {
  server: { port: number; token: string; authMode: 'bearer' | 'none'; allowLan: boolean };
  behavior: {
    autoIndex: boolean;
    respectGitignore: boolean;
    ignoreHidden: boolean;
    followSymlinks: boolean;
    rescanIntervalSec: number;
    maxFileSizeMB: number;
    excludePatterns: string[];
  };
  types: { preset: string; extensions: string[] };
  embedding: { modelId: string | null };
  chunk: { size: number; overlap: number; min: number };
  retrieval: { topK: number; threshold: number; hybrid: number };
  ui: { theme: string; animations: boolean };
};

/* Eventos push main → renderer */
export type CerebroEvent =
  | { type: 'log'; entry: LogEntry }
  | { type: 'index:progress'; progress: IndexProgress }
  | { type: 'folders:changed' }
  | { type: 'stats:changed' }
  | { type: 'model:download'; modelId: string; status: string; progress: number; loaded: number; total: number }
  | { type: 'server:status'; status: ServerStatus }
  | { type: 'clients:changed' };

/* Superficie IPC expuesta al renderer vía preload */
export interface CerebroApi {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  onEvent(cb: (ev: CerebroEvent) => void): () => void;
}
