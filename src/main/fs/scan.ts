import { promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ignore from 'ignore';
import picomatch from 'picomatch';
import type { ExtStat } from '../../shared/types';

export interface ScanOptions {
  extensions: string[]; // con punto, minúsculas; vacío = todas
  maxFileBytes: number;
  excludePatterns: string[];
  ignoreHidden: boolean;
  respectGitignore: boolean;
  followSymlinks: boolean;
}

export interface ScannedFile {
  path: string;
  ext: string;
  size: number;
  mtime: number;
}

export interface ScanResult {
  files: ScannedFile[];
  extStats: ExtStat[];
  dirsIgnored: number;
}

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.tox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.gradle', '.idea', '.cache',
  'target', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage', '.terraform'
]);

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  if (i > 0) return name.slice(i).toLowerCase();
  if (i === 0 && name.length > 1) return name.slice(0).toLowerCase(); // .env, .gitignore
  return '';
};

/* Escanea recursivamente una raíz aplicando todos los filtros de configuración. */
export async function scanFolder(
  root: string,
  opts: ScanOptions,
  onProgress?: (scanned: number) => void
): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  const extMap = new Map<string, ExtStat>();
  let dirsIgnored = 0;
  let scanned = 0;

  const extSet = opts.extensions.length > 0 ? new Set(opts.extensions.map((e) => e.toLowerCase())) : null;
  const hasExcludes = opts.excludePatterns.length > 0;
  const matchExclude = hasExcludes
    ? picomatch(opts.excludePatterns.map((p) => (p.endsWith('/') ? p + '**' : p)), { dot: true, nocase: process.platform === 'win32' })
    : null;

  const gitIgnores: { base: string; ig: ReturnType<typeof ignore> }[] = [];
  if (opts.respectGitignore) {
    try {
      const raw = await fsp.readFile(join(root, '.gitignore'), 'utf8');
      gitIgnores.push({ base: root, ig: ignore().add(raw) });
    } catch {
      /* sin .gitignore en la raíz */
    }
  }

  const ignoredByGit = (absPath: string, isDir: boolean): boolean => {
    if (!opts.respectGitignore || gitIgnores.length === 0) return false;
    for (const { base, ig } of gitIgnores) {
      const rel = relative(base, absPath).split(sep).join('/');
      if (!rel || rel.startsWith('..')) continue;
      if (ig.ignores(isDir ? rel + '/' : rel)) return true;
    }
    return false;
  };

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      scanned++;
      if (scanned % 500 === 0) onProgress?.(scanned);

      if (opts.ignoreHidden && entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink() && !opts.followSymlinks) continue;

      let isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) {
        try {
          const st = await fsp.stat(abs);
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
        if (matchExclude && matchExclude(abs.split(sep).join('/'))) {
          dirsIgnored++;
          continue;
        }
        if (ignoredByGit(abs, true)) {
          dirsIgnored++;
          continue;
        }
        // .gitignore anidado
        if (opts.respectGitignore) {
          try {
            const raw = await fsp.readFile(join(abs, '.gitignore'), 'utf8');
            gitIgnores.push({ base: abs, ig: ignore().add(raw) });
          } catch {
            /* no tiene */
          }
        }
        await walk(abs);
        continue;
      }

      // Fichero
      const effExt = extOf(entry.name) || specialExt(entry.name);
      if (extSet && !extSet.has(effExt)) continue;
      if (matchExclude && matchExclude(abs.split(sep).join('/'))) continue;
      if (ignoredByGit(abs, false)) continue;

      try {
        const st = await fsp.stat(abs);
        if (st.size > opts.maxFileBytes) continue;
        if (st.size === 0) continue;
        files.push({ path: abs, ext: effExt, size: st.size, mtime: Math.floor(st.mtimeMs) });
        const key = effExt || '(sin ext)';
        const cur = extMap.get(key) ?? { ext: key, count: 0, bytes: 0 };
        cur.count++;
        cur.bytes += st.size;
        extMap.set(key, cur);
      } catch {
        /* sin permisos o raced */
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

const specialExt = (name: string): string => {
  const base = name.toLowerCase();
  if (base.startsWith('makefile')) return '.makefile';
  if (base.startsWith('dockerfile')) return '.dockerfile';
  if (base.startsWith('readme')) return '.md';
  if (base.startsWith('license') || base.startsWith('changelog') || base.startsWith('authors')) return '.txt';
  if (base === 'procfile' || base === 'gemfile' || base === 'cname') return '.txt';
  return '';
};
