import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { CerebroApp } from './app';
import { coreHandlers, type CoreHandler } from './handlers';

let win: BrowserWindow | null = null;
let cerebro: CerebroApp | null = null;

/* La UI puede invocar IPC antes de que el cerebro termine de inicializar (detección de
   hardware, DB, servidor). Esta promise elimina la carrera: los handlers esperan a que
   el arranque termine (o fallan con el error real de arranque, nunca en silencio). */
let readyResolve!: () => void;
const readyPromise = new Promise<void>((res) => (readyResolve = res));
let bootError: string | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#080a0e',
    title: 'Cerebro Local',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  void win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function send(ev: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send('cerebro:event', ev);
}

async function bootstrap(): Promise<void> {
  const baseDir = join(app.getPath('userData'), 'data');
  cerebro = await CerebroApp.create(baseDir, { startServer: true });
  cerebro.onEvent(send);
  cerebro.logger.info('Cerebro listo · la interfaz puede usarlo');

  // arranque automático del pipeline si hay trabajo pendiente
  if (cerebro.getSettings().behavior.autoIndex && cerebro.indexer.hasWorkPending()) {
    cerebro.logger.info('Indexación automática: hay archivos pendientes');
    void cerebro.indexer.start({});
  }
}

/* Espera a que el cerebro esté inicializado; si el arranque falló, lanza el error real. */
async function ready(): Promise<CerebroApp> {
  await readyPromise;
  if (!cerebro) throw new Error(bootError ?? 'El cerebro no terminó de inicializar');
  return cerebro;
}

/* ── IPC ───────────────────────────────────────────────── */

function handle(channel: string, fn: (app: CerebroApp, ...args: any[]) => any): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      const c = await ready();
      return await fn(c, ...args);
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  });
}

/* Extras propios de Electron (dialog/shell) que se suman a los handlers compartidos.
   Se registran después del mapa compartido para que puedan sobrescribirlo. */
const electronExtras: Record<string, CoreHandler> = {
  'app:status': () => ({ ready: cerebro !== null, bootError }),
  'folders:pick': async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Selecciona una carpeta para el cerebro',
      properties: ['openDirectory']
    });
    return res.canceled ? null : res.filePaths[0];
  },
  'open-path': (_c, path: string) => shell.showItemInFolder(path)
};

function registerIpc(): void {
  const channels: Record<string, CoreHandler> = { ...coreHandlers, ...electronExtras };
  for (const [channel, fn] of Object.entries(channels)) handle(channel, fn);
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  try {
    await bootstrap();
  } catch (e: any) {
    bootError = e?.message ?? String(e);
    console.error('Fallo al arrancar el cerebro:', e);
  } finally {
    readyResolve();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  if (cerebro) {
    e.preventDefault();
    void cerebro.shutdown().finally(() => {
      cerebro = null;
      app.quit();
    });
  }
});
