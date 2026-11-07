import { EmbeddingEngine } from './src/main/models/engine';
import { getModel } from './src/main/models/catalog';
const model = getModel('bge-m3')!;
const dir = process.env.HOME + '/.config/cerebro-local/data/cerebro/models';
const eng = new EmbeddingEngine(dir, 'cuda', (m) => console.log('  [aviso]', m));
(async () => {
  const t0 = Date.now();
  await eng.embedQuery(model, 'hola');
  const t1 = Date.now();
  for (let i=0;i<4;i++) await eng.embedQuery(model, 'prueba '+i);
  const t2 = Date.now();
  console.log(`device=${eng.computeDevice} carga1=${((t1-t0)/1000).toFixed(1)}s media=${((t2-t1)/4).toFixed(0)}ms`);
})();
