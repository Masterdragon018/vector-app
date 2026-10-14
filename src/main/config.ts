import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../shared/types';

const DEFAULTS: Settings = {
  server: { port: 7433, token: '', authMode: 'bearer', allowLan: false },
  behavior: {
    autoIndex: true,
    respectGitignore: true,
    ignoreHidden: true,
    followSymlinks: false,
    rescanIntervalSec: 120,
    maxFileSizeMB: 10,
    excludePatterns: ['*.min.js', '*.lock', 'dist/', 'build/', 'node_modules/', '.git/']
  },
  types: {
    preset: 'text',
    extensions: ['.txt', '.md', '.mdx', '.rst', '.json', '.csv', '.yaml', '.yml', '.toml']
  },
  embedding: { modelId: null },
  chunk: { size: 512, overlap: 64, min: 48 },
  retrieval: { topK: 8, threshold: 0.35, hybrid: 60 },
  ui: { theme: 'dark', animations: true }
};

function deepMerge<T>(base: T, patch: any): T {
  if (patch === null || patch === undefined || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : (patch as T);
  }
  const src = base as any as object | undefined;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(src ?? {}) };
  for (const k of Object.keys(patch)) {
    out[k] = src && k in src ? deepMerge((src as any)[k], patch[k]) : patch[k];
  }
  return out as T;
}

export class ConfigStore {
  readonly file: string;
  private data: Settings;

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'config.json');
    this.data = structuredClone(DEFAULTS);
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        this.data = deepMerge(structuredClone(DEFAULTS), raw);
      } catch {
        /* config corrupto → usamos defaults */
      }
    }
    if (!this.data.server.token) {
      this.data.server.token = 'clb_' + randomBytes(16).toString('hex');
      this.save();
    }
  }

  get(): Settings {
    return this.data;
  }

  set(patch: any): Settings {
    this.data = deepMerge(this.data, patch);
    this.save();
    return this.data;
  }

  regenerateToken(): string {
    this.data.server.token = 'clb_' + randomBytes(16).toString('hex');
    this.save();
    return this.data.server.token;
  }

  private save(): void {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}

export const dataDirFor = (base: string) => {
  const dir = join(base, 'cerebro');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};
export const modelsDirFor = (dataDir: string) => {
  const dir = join(dataDir, 'models');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};
