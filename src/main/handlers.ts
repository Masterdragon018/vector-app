/* Handlers de la superficie de control compartidos entre Electron (IPC) y la UI web (/bridge).
   Cada handler recibe la instancia de CerebroApp como primer argumento. Los canales que
   dependen de Electron (folders:pick, open-path) viven en src/main/index.ts. */
import { existsSync, promises as fsp } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CerebroApp } from './app';

export type CoreHandler = (c: CerebroApp, ...args: any[]) => any;

/* Raíces habituales del explorador de carpetas de la UI web. */
function fsRoots(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [{ name: 'Inicio', path: homedir() }];
  const add = (name: string, p: string): void => {
    if (p && existsSync(p) && !out.some((r) => r.path === p)) out.push({ name, path: p });
  };
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') add(`${letter}:`, `${letter}:\\`);
  } else {
    add('Raíz', '/');
    add('Medios', '/mnt');
    try {
      const user = userInfo().username;
      add('Medios', `/media/${user}`);
      add('Medios', `/run/media/${user}`);
    } catch {
      /* sin userInfo (entornos raros) */
    }
    if (process.platform === 'darwin') add('Volúmenes', '/Volumes');
  }
  return out;
}

export const coreHandlers: Record<string, CoreHandler> = {
  'app:status': (c) => ({ ready: true, hardware: c.hardware, bootError: null }),

  snapshot: (c) => c.snapshot(),
  hardware: (c) => c.hardware,

  'folders:list': (c) => c.db.listFolders(),
  'folders:add': async (c, path: string) => {
    await c.addFolder(path);
    return c.db.listFolders();
  },
  'folders:remove': (c, id: number) => {
    c.removeFolder(id);
    return c.db.listFolders();
  },
  'folders:toggle': (c, id: number, enabled: boolean) => {
    c.toggleFolder(id, enabled);
    return c.db.listFolders();
  },

  /* Explorador de carpetas (modo web): devuelve SOLO directorios, nunca
     contenido de archivos. El navegador no puede leer rutas absolutas del
     equipo, así que el listado lo hace el servidor. */
  'fs:list': async (_c, pathArg?: string) => {
    const target = resolve(String(pathArg ?? '').trim() || homedir());
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fsp.readdir(target, { withFileTypes: true });
    } catch (e: any) {
      const why =
        e?.code === 'EACCES' || e?.code === 'EPERM'
          ? 'sin permisos'
          : e?.code === 'ENOENT'
            ? 'no existe'
            : e?.message ?? String(e);
      throw new Error(`No se puede abrir «${target}»: ${why}`);
    }
    const entries: { name: string; path: string }[] = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue; // ocultas: se pueden escribir a mano
      const full = join(target, d.name);
      let isDir = d.isDirectory();
      if (!isDir && d.isSymbolicLink()) {
        try {
          isDir = (await fsp.stat(full)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) entries.push({ name: d.name, path: full });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const up = dirname(target);
    return { path: target, parent: up !== target ? up : null, entries, roots: fsRoots() };
  },

  'index:start': (c, opts: any) => {
    void c.indexer.start(opts ?? {});
    return c.indexer.progress;
  },
  'index:full': (c) => {
    void c.indexer.start({ full: true });
    return c.indexer.progress;
  },
  'index:pause': (c) => c.indexer.pause(),
  'index:resume': (c) => c.indexer.resume(),
  'index:stop': (c) => c.indexer.stop(),
  'index:progress': (c) => c.indexer.progress,

  'model:catalog': (c) => c.modelCatalog(),
  'model:download': (c, id: string) => c.downloadModel(id),
  'model:select': (c, id: string) => c.selectModel(id),

  'clients:list': (c) => c.listClients(),

  'settings:get': (c) => c.getSettings(),
  'settings:set': (c, patch: any) => c.updateSettings(patch),
  'token:regenerate': async (c) => {
    c.config.regenerateToken();
    return c.restartServer();
  },
  'server:restart': (c) => c.restartServer(),
  'server:status': (c) => c.serverStatus(),

  search: (c, query: string, opts: any) => c.search(query, opts ?? {}),
  stats: (c) => c.db.dashboardStats(),
  'ext:stats': (c) => c.db.extensionStats(),
  'logs:tail': (c, limit?: number) => c.logger.tail(limit),
  'logs:clear': (c) => {
    c.logger.clear();
    return true;
  }
};

/* Despacha un canal devolviendo {result} o {error} — misma semántica que el wrapper IPC. */
export async function dispatchCore(app: CerebroApp, channel: string, args: unknown[]): Promise<{ result?: unknown; error?: string }> {
  const handler = coreHandlers[channel];
  if (!handler) return { error: `Canal desconocido: ${channel}` };
  try {
    return { result: await handler(app, ...args) };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}
