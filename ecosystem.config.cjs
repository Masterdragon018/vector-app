// Config de pm2 para Cerebro Local como servicio (modo web, sin Electron).
//
//   npm run build          # compila dist/ (main + renderer)
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup # arranque automático al encender el equipo
//
// Corre `dist/main/web.js` con Node sobre node_modules del proyecto, así que usa
// el runtime CUDA ya configurado por `npm run gpu:setup` (Linux) — sin pasar por
// el empaquetado de Electron. La GPU se elige al arrancar y queda en los logs.
const os = require('node:os');
const path = require('node:path');

// Directorio de datos (config, DB, modelos). Reutiliza el del modo Electron por
// defecto para no re-descargar modelos ni re-indexar.
const CEREBRO_HOME =
  process.env.CEREBRO_HOME || path.join(os.homedir(), '.config', 'cerebro-local', 'data');

module.exports = {
  apps: [
    {
      name: 'cerebro-local',
      script: 'dist/main/web.js',
      cwd: __dirname,
      interpreter: 'node',
      // un servicio no abre navegador; la UI se abre en el navegador que quieras
      env: {
        NODE_ENV: 'production',
        CEREBRO_NO_OPEN: '1',
        CEREBRO_HOME
      },
      // mantenerse vivo: reinicio ante caída, backoff y sin watch (no es desarrollo)
      autorestart: true,
      watch: false,
      max_restarts: 20,
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000,
      // el apagado ordenado (SIGTERM) tarda hasta 4 s: dale margen
      kill_timeout: 8000,
      // logs con fecha; pm2 los rota con `pm2 install pm2-logrotate` si se desea
      merge_logs: true,
      time: true
    }
  ]
};
