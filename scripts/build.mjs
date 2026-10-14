// Build: main y preload en CJS (Node/Electron), renderer en IIFE (file://)
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const common = { logLevel: 'info', sourcemap: true, minify: false };

await build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/main/index.js',
  packages: 'external'
});

await build({
  ...common,
  entryPoints: ['src/main/web.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/main/web.js',
  packages: 'external'
});

await build({
  ...common,
  entryPoints: ['src/preload/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/preload/index.js',
  packages: 'external'
});

await build({
  ...common,
  entryPoints: ['src/renderer/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  outfile: 'dist/renderer/app.js'
});

await mkdir('dist/renderer', { recursive: true });
await cp('src/renderer/index.html', 'dist/renderer/index.html');
await cp('src/renderer/styles.css', 'dist/renderer/styles.css');

console.log('✓ build completo → dist/');
