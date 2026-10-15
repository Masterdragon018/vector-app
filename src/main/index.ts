import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { join } from 'node:path';
import { CerebroApp } from './app';
import { coreHandlers, type CoreHandler } from './handlers';

let win: BrowserWindow | null = null;
let cerebro: CerebroApp | null = null;
let tray: Tray | null = null;
let quitting = false;

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
    icon: join(__dirname, '../renderer/logo.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  void win.loadFile(join(__dirname, '../renderer/index.html'));

  /* Cerrar la ventana NO mata el cerebro: la app sigue en segundo plano
     (bandeja) para que los agentes sigan consultando por MCP/API. */
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function createTray(): void {
  const iconPath = join(__dirname, '../renderer/logo.png');
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img);
  tray.setToolTip('Cerebro Local · el cerebro sigue activo en segundo plano');
  const menu = Menu.buildFromTemplate([
    {
      label: 'Abrir Cerebro Local',
      click: () => {
        win?.show();
        win?.focus();
      }
    },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (win?.isVisible()) win.hide();
    else {
      win?.show();
      win?.focus();
    }
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

  // 1. el modelo de embeddings SIEMPRE se carga al arrancar (en segundo plano)
  void cerebro.preloadModel().then(() => {
    // 2. …y solo entonces, si hay trabajo pendiente, se indexa
    if (cerebro!.getSettings().behavior.autoIndex && cerebro!.indexer.hasWorkPending()) {
      cerebro!.logger.info('Indexación automática: hay archivos pendientes');
      void cerebro!.indexer.start({});
    }
  });
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
  createTray();
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

/* Cerrar la ventana deja el servicio vivo (bandeja); solo «Salir» del menú
   de bandeja o el fin de la sesión terminan el proceso. */
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.on('before-quit', (e) => {
  if (cerebro) {
    e.preventDefault();
    quitting = true;
    void cerebro.shutdown().finally(() => {
      cerebro = null;
      app.quit();
    });
  }
});
