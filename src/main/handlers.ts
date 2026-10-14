/* Handlers de la superficie de control compartidos entre Electron (IPC) y la UI web (/bridge).
   Cada handler recibe la instancia de CerebroApp como primer argumento. Los canales que
   dependen de Electron (folders:pick, open-path) viven en src/main/index.ts. */
import type { CerebroApp } from './app';

export type CoreHandler = (c: CerebroApp, ...args: any[]) => any;

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
