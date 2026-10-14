/* Smoke test end-to-end (sin Electron):
   1. Crea un workspace temporal de prueba
   2. Arranca el cerebro (server incluido)
   3. Descarga el modelo más ligero
   4. Indexa, busca y verifica resultados
   5. Prueba la API REST y el servidor MCP con HTTP real
*/
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// el home del smoke vive en el proyecto para reutilizar la caché de modelos entre ejecuciones
const home = join(process.cwd(), '.smoke-home');
if (!existsSync(home)) mkdirSync(home, { recursive: true });
const ws = mkdtempSync(join(tmpdir(), 'cerebro-ws-'));

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    failures++;
  } else {
    console.log(`✓ ${msg}`);
  }
}
let failures = 0;

async function main(): Promise<void> {
  /* ── 1. Workspace de prueba ── */
  mkdirSync(join(ws, 'notas'), { recursive: true });
  mkdirSync(join(ws, 'codigo'), { recursive: true });
  writeFileSync(
    join(ws, 'notas', 'arquitectura.md'),
    [
      '# Arquitectura del proyecto api-gateway',
      '',
      'El proyecto api-gateway sigue una arquitectura en tres capas.',
      'La capa de entrada es un router en src/routes/ que valida peticiones HTTP.',
      'La capa de dominio contiene servicios en src/services/ sin dependencias de HTTP.',
      'La capa de datos usa repositorios en src/repos/ que abstraen PostgreSQL.',
      'El README menciona que la separación permite testear el dominio sin servidor.'
    ].join('\n')
  );
  writeFileSync(
    join(ws, 'notas', 'decisiones.md'),
    [
      '# Decisiones técnicas',
      '',
      'ADR-004: decidimos usar PostgreSQL como base de datos principal por su robustez transaccional.',
      'ADR-007: la autenticación será basada en tokens JWT con rotación automática.',
      'ADR-011: se eligió SQLite con sqlite-vec para el índice vectorial local.'
    ].join('\n')
  );
  writeFileSync(
    join(ws, 'codigo', 'gateway.ts'),
    [
      '// api-gateway: router principal',
      'export function createRouter() {',
      '  // valida y normaliza las peticiones entrantes',
      '  return { routes: [] };',
      '}',
      'export const DB_URL = process.env.DATABASE_URL ?? "postgres://localhost/gateway";'
    ].join('\n')
  );
  writeFileSync(join(ws, 'codigo', 'notas.txt'), 'nota suelta: recordar renovar el certificado TLS del gateway.');
  writeFileSync(join(ws, 'ignore.md'), 'este archivo está en la raíz, también se indexa');
  console.log(`Workspace de prueba: ${ws}`);

  process.env.CEREBRO_HOME = home;
  const { CerebroApp } = await import('../src/main/app');
  const app = await CerebroApp.create(home, { startServer: true });

  /* ── 2. Hardware y recomendación ── */
  const hw = app.hardware;
  console.log(`\nEquipo: ${hw.cpuCores} núcleos · ${hw.ramTotalGB} GB RAM · GPU: ${hw.gpus.map((g) => g.name).join(',') || 'ninguna'}`);
  const rec = app.currentRecommendation();
  console.log(`Recomendación: ${rec.modelId} (${rec.tier}) — ${rec.reason}`);
  assert(!!rec.modelId, 'recomendación de modelo según hardware');

  /* ── 3. Descarga del modelo recomendado (o el más pequeño) ── */
  const target = app.modelCatalog().some((m) => m.downloaded && m.id === rec.modelId)
    ? rec.modelId
    : app.modelCatalog().sort((a, b) => a.downloadMB - b.downloadMB)[0].id;
  console.log(`\nDescargando modelo ${target} (~puede tardar la primera vez)…`);
  const t0 = Date.now();
  const dl = await app.downloadModel(target);
  assert(dl.ok, `descarga del modelo ${target}${dl.error ? ` — ${dl.error}` : ''} (${Math.round((Date.now() - t0) / 1000)} s)`);
  if (!dl.ok) throw new Error('No se pudo descargar el modelo: ' + dl.error);

  if (target !== app.getSettings().embedding.modelId) {
    const sel = await app.selectModel(target);
    assert(sel.ok, 'selección del modelo');
  }

  /* ── 4. Indexación ── */
  await app.addFolder(ws);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const st = app.db.dashboardStats();
    if (st.pending === 0 && st.files > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const stats = app.db.dashboardStats();
  console.log(`\nIndexados: ${stats.files} archivos · ${stats.chunks} fragmentos · pendientes: ${stats.pending}`);
  // el filtro de tipos por defecto excluye .ts → se indexan 4 de los 5 ficheros
  assert(stats.files === 4, `archivos indexados = 4 (el .ts queda fuera del filtro por defecto; hay ${stats.files})`);
  assert(stats.chunks >= 4, `fragmentos generados (${stats.chunks} >= 4)`);
  assert(stats.pending === 0, 'sin archivos pendientes');

  /* ── 5. Búsqueda semántica ── */
  const res1 = await app.search('¿qué base de datos elegimos?', { topK: 3 });
  console.log(`\nBúsqueda "¿qué base de datos elegimos?": ${res1.resultados.length} resultados en ${res1.ms} ms`);
  for (const r of res1.resultados) console.log(`  · [${r.score.toFixed(2)}] ${r.ruta.split('/').pop()} :: ${r.texto.slice(0, 70)}…`);
  assert(res1.resultados.length > 0, 'búsqueda semántica devuelve resultados');
  assert(
    res1.resultados.some((r) => r.ruta.endsWith('decisiones.md')),
    'encuentra el documento correcto (decisiones.md sobre base de datos)'
  );
  assert(res1.resultados.every((r) => r.score >= 0 && r.score <= 1), 'scores en rango [0,1]');

  const res2 = await app.search('arquitectura del proyecto', { topK: 3 });
  assert(
    res2.resultados.some((r) => r.ruta.endsWith('arquitectura.md')),
    'búsqueda sobre arquitectura encuentra arquitectura.md'
  );

  const res3 = await app.search('zzzxyzqwerty consulta imposible', { topK: 3 });
  assert(Array.isArray(res3.resultados), 'consulta sin coincidencias no revienta');

  /* ── 6. API REST ── */
  const port = app.serverStatus().port;
  const token = app.getSettings().server.token;
  const base = `http://127.0.0.1:${port}`;

  const health = await (await fetch(`${base}/v1/salud`)).json();
  assert(health.ok === true, 'API /v1/salud responde');

  const unauth = await fetch(`${base}/v1/carpetas`);
  assert(unauth.status === 401, 'API rechaza peticiones sin token (401)');

  const apiRes = await fetch(`${base}/v1/buscar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: 'tokens JWT', top_k: 2 })
  });
  const apiJson: any = await apiRes.json();
  assert(apiRes.ok && apiJson.resultados?.length > 0, `API /v1/buscar devuelve resultados (${apiJson.resultados?.length})`);

  const docRes = await fetch(`${base}/v1/documento?path=${encodeURIComponent(join(ws, 'notas', 'decisiones.md'))}&limit=200`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const docJson: any = await docRes.json();
  assert(docRes.ok && docJson.contenido?.includes('ADR-004'), 'API /v1/documento devuelve el contenido');

  const forbidden = await fetch(`${base}/v1/documento?path=${encodeURIComponent('/etc/passwd')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert(forbidden.status === 403, 'API /v1/documento deniega rutas fuera de carpetas indexadas (403)');

  /* ── 7. MCP (Streamable HTTP) ── */
  const mcpHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`
  };
  const parseMcp = async (res: Response): Promise<any> => {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      const text = await res.text();
      const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
      return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
    }
    return res.json();
  };

  const initRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } } })
  });
  const initJson = await parseMcp(initRes);
  assert(initJson?.result?.serverInfo?.name === 'cerebro-local', `MCP initialize OK (servidor: ${initJson?.result?.serverInfo?.name})`);

  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  });

  const toolsRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  const toolsJson = await parseMcp(toolsRes);
  const toolNames = (toolsJson?.result?.tools ?? []).map((t: any) => t.name);
  console.log(`\nHerramientas MCP: ${toolNames.join(', ')}`);
  assert(['buscar', 'listar_carpetas', 'leer_documento', 'estado_index'].every((n) => toolNames.includes(n)), 'las 4 herramientas MCP están registradas');

  const callRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'buscar', arguments: { query: 'certificado TLS', top_k: 2 } } })
  });
  const callJson = await parseMcp(callRes);
  const callText = JSON.stringify(callJson?.result ?? callJson);
  assert(callText.includes('notas.txt'), 'tool buscar vía MCP encuentra el archivo esperado');

  const unauthMcp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } })
  });
  assert(unauthMcp.status === 401, 'MCP rechaza conexiones sin token (401)');

  /* ── 8. Limpieza (conservamos la caché de modelos) ── */
  await app.shutdown();
  rmSync(join(home, 'cerebro', 'cerebro.db'), { force: true });
  rmSync(join(home, 'cerebro', 'cerebro.db-wal'), { force: true });
  rmSync(join(home, 'cerebro', 'cerebro.db-shm'), { force: true });
  rmSync(join(home, 'cerebro', 'config.json'), { force: true });
  rmSync(ws, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '✅ SMOKE TEST OK' : `❌ ${failures} fallos`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FALLO FATAL:', e);
  process.exit(1);
});
