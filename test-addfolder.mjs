import { CerebroApp } from './dist/main/app.js';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const home = './.smoke-home';
  // Remover db anterior
  try { fs.rmSync(join(home, 'cerebro'), { recursive: true }); } catch(e) {}
  
  const app = await CerebroApp.create(home, { startServer: true });
  
  // Probar addFolder con el workspace temporal
  const ws = require('os').tmpdir() + '/test-folder-' + Date.now();
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'test.txt'), 'contenido de prueba');
  
  console.log('Intentando añadir carpeta:', ws);
  const result = await app.addFolder(ws);
  console.log('Resultado addFolder:', JSON.stringify(result, null, 2));
  
  // Listar carpetas
  const folders = await app.invoke('folders:list');
  console.log('Carpetas:', JSON.stringify(folders, null, 2));
  
  await app.shutdown();
}

main().catch(e => console.error(e));
