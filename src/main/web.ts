/* Entrada modo web: arranca el cerebro completo (hardware, DB, embeddings, API, MCP)
   y sirve la interfaz en el navegador. Sin Electron: `npm start` → http://127.0.0.1:PUERTO */
import { spawn } from 'node:child_process';
import { CerebroApp, defaultBaseDir } from './app';

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const ch = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    ch.on('error', () => {
      /* sin navegador: el usuario abre la URL a mano */
    });
    ch.unref();
  } catch {
    /* noop */
  }
}

async function main(): Promise<void> {
  console.log('\n  Cerebro Local — modo web\n');

  const cerebro = await CerebroApp.create(defaultBaseDir(), { startServer: true });
  const st = cerebro.serverStatus();
  const url = st.url;
  const snap = await cerebro.snapshot();
  const deviceLabel =
    snap.device === 'cuda' ? 'GPU (CUDA)' : snap.device === 'dml' ? 'GPU (DirectML)' : 'CPU';
  const gpuName = snap.hardware.gpus[0]?.name;

  // el modelo de embeddings SIEMPRE se carga al arrancar; después, si hay
  // trabajo pendiente, se lanza la indexación
  void cerebro.preloadModel().then(() => {
    if (cerebro.getSettings().behavior.autoIndex && cerebro.indexer.hasWorkPending()) {
      cerebro.logger.info('Indexación automática: hay archivos pendientes');
      void cerebro.indexer.start({});
    }
  });

  console.log(`  ➜ Interfaz:  ${url}`);
  console.log(`  ➜ API:       ${url}/v1/buscar (Bearer ${st.token})`);
  console.log(`  ➜ MCP:       ${st.mcpUrl}`);
  console.log(`  ➜ Motor:     ${deviceLabel}${gpuName ? ` · ${gpuName}` : ''}`);
  console.log(`  ➜ Datos:     ${cerebro.dataDir}`);
  console.log('\n  Ctrl+C para detener.\n');
  // como servicio (pm2) no se abre navegador: CEREBRO_NO_OPEN=1 o --no-open
  const noOpen = process.env.CEREBRO_NO_OPEN === '1' || process.argv.includes('--no-open');
  if (!noOpen) openBrowser(url);

  let stopping = false;
  const stop = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n  (${sig}) Deteniendo el cerebro…`);
    void cerebro
      .shutdown()
      .catch((e) => console.error('  Error al detener:', e))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((e) => {
  console.error('\n  ✗ No se pudo arrancar el cerebro:\n', e);
  process.exit(1);
});
