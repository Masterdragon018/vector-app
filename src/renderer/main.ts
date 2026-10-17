/* Renderer: conecta la interfaz (basada en el borrador) al cerebro real vía IPC */
import type {
  ClientInfo,
  CerebroApi,
  CerebroEvent,
  FolderInfo,
  IndexProgress,
  LogEntry,
  ModelRecommendation,
  SearchResult,
  ServerStatus,
  Settings
} from '../shared/types';
import { EXTENSIONS, PRESETS, SUPPORTED_EXTS } from '../shared/presets';
import { APP_VERSION } from '../shared/version';

declare global {
  interface Window {
    cerebro: CerebroApi;
  }
}

const nativeApi = window.cerebro;
const IS_WEB = !nativeApi;

/* Puente HTTP para la versión navegador (mismos canales que el IPC de Electron):
   POST /bridge → {result|error} · eventos push vía SSE /events */
const webApi: CerebroApi = {
  invoke: async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const r = await fetch('/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args })
    });
    if (!r.ok) throw new Error(`Servidor HTTP ${r.status}`);
    const j = (await r.json()) as any;
    return (j && typeof j === 'object' && 'result' in j ? j.result : j) as T;
  },
  onEvent: (cb) => {
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      try {
        cb(JSON.parse(e.data));
      } catch {
        /* evento malformado */
      }
    };
    return () => es.close();
  }
};

const api: CerebroApi = nativeApi ?? webApi;

/* Invocación central: los handlers devuelven {error} en vez de lanzar; aquí se
   convierten en excepciones para que la UI pueda mostrarlas y reintentar. */
const invoke = async <T = any>(ch: string, ...args: unknown[]): Promise<T> => {
  const out = await api.invoke<any>(ch, ...args);
  if (out && typeof out === 'object' && 'error' in out && out.error) {
    throw new Error(String(out.error));
  }
  return out as T;
};

/* ═════════ Utils ═════════ */
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string): T[] => [...document.querySelectorAll(sel)] as T[];
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const nf = (n: number) => n.toLocaleString('es-ES');
const bytes = (n: number): string => {
  if (n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};

/* ═════════ Toasts ═════════ */
const TOAST_ICONS: Record<string, string> = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>'
};

function toast(msg: string, kind: 'ok' | 'info' | 'warn' = 'ok', ms = 2800): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = (TOAST_ICONS[kind] ?? TOAST_ICONS.ok) + `<span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

function copyText(text: string, okMsg = 'Copiado al portapapeles'): void {
  navigator.clipboard.writeText(text).then(
    () => toast(okMsg),
    () => toast('No se pudo copiar', 'warn')
  );
}

/* ═════════ Estado global ═════════ */
let settings: Settings;
let folders: FolderInfo[] = [];
let progress: IndexProgress | null = null;
let serverSt: ServerStatus | null = null;
let rec: ModelRecommendation | null = null;
let activeModelId: string | null = null;
let computeDevice: 'cuda' | 'dml' | 'cpu' = 'cpu';
let searchLatency = 0;

/* ═════════ Navegación ═════════ */
const TITLES: Record<string, [string, string]> = {
  home: ['Red neuronal', 'conocimiento vectorizado'],
  resumen: ['Resumen', 'estado en tiempo real'],
  carpetas: ['Carpetas', 'selecciona qué indexar'],
  tipos: ['Tipos de archivo', 'formatos admitidos'],
  modelos: ['Modelos', 'embeddings y fragmentación'],
  playground: ['Playground', 'prueba el cerebro'],
  conexion: ['Conexión', 'MCP · API'],
  clientes: ['Clientes', 'agentes conectados'],
  registro: ['Registro', 'eventos en vivo'],
  ajustes: ['Ajustes', 'configuración general']
};

function go(view: string): void {
  $$('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(`view-${view}`)?.classList.add('active');
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));  const t = TITLES[view] ?? ['', ''];
  $('#topTitle').textContent = t[0];
  $('#topSub').textContent = t[1];
  if (view === 'home') scheduleCanvasResize();

  if (view === 'resumen') void refreshStats();
  if (view === 'clientes') void refreshClients();
}

$$('.nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.view!)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => go((b as HTMLElement).dataset.goto!)));
$$('[data-toggle]').forEach((h) =>
  h.addEventListener('click', () => document.getElementById(h.dataset.toggle!)?.classList.toggle('open'))
);

/* ═════════ Red neuronal (canvas) ═════════ */
const canvas = $('#net') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const tip = $('#nodeTip');
let W = 0,
  H = 0,
  zoom = 1,
  hovered: number | null = null,
  netFilter = 'all',
  t0 = performance.now();
type NetNode = { name: string; files: number; status: string; bx: number; by: number; x: number; y: number; r: number; phase: number; drift: number };
let nodes: NetNode[] = [];
let edges: { a: number; b: number }[] = [];

const COLOR: Record<string, { hex: string; rgb: number[] }> = {
  ok: { hex: '#34d399', rgb: [52, 211, 153] },
  index: { hex: '#fbbf24', rgb: [251, 191, 36] },
  pending: { hex: '#626b7e', rgb: [98, 107, 126] }
};
const statusOf = (f: FolderInfo): string =>
  f.status === 'ready' ? 'ok' : f.status === 'indexing' || f.status === 'scanning' ? 'index' : 'pending';

function buildGraph(): void {
  const src = folders.length > 0 ? folders : [{ name: 'Sin carpetas', fileCount: 0, status: 'pending' } as any];
  const R = Math.min(W * 0.33, H * 0.34) || 160;
  const n = Math.max(src.length, 1);
  nodes = src.map((f, i) => {
    const a = ((-90 + i * (360 / n)) * Math.PI) / 180;
    const rr = R * (0.84 + (i % 2) * 0.28);
    return {
      name: f.name,
      files: f.fileCount,
      status: statusOf(f),
      bx: W / 2 + Math.cos(a) * rr * 1.22,
      by: H / 2 + Math.sin(a) * rr * 0.92,
      x: 0,
      y: 0,
      r: 15 + Math.min(11, f.fileCount / 380),
      phase: i * 1.7,
      drift: 6 + (i % 3) * 3
    };
  });
  edges = [];
  nodes.forEach((_, i) => {
    edges.push({ a: -1, b: i });
    edges.push({ a: i, b: (i + 1) % nodes.length });
  });
  if (nodes.length > 3) edges.push({ a: 0, b: 3 });
  if (nodes.length > 5) edges.push({ a: 2, b: 4 });
}

function scheduleCanvasResize(): void {
  const rect = canvas.parentElement!.getBoundingClientRect();
  if (rect.width < 10) {
    setTimeout(scheduleCanvasResize, 120);
    return;
  }
  W = rect.width;
  H = rect.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  buildGraph();
  t0 = performance.now();
}

function draw(now: number): void {
  requestAnimationFrame(draw);
  if (W < 10 || H < 10 || document.hidden) return;
  const t = (now - t0) / 1000;
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2,
    cy = H / 2;

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.6);
  grad.addColorStop(0, 'rgba(59,130,246,.08)');
  grad.addColorStop(0.5, 'rgba(34,211,238,.022)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  nodes.forEach((n) => {
    n.x = n.bx + Math.sin(t * 0.42 + n.phase) * n.drift;
    n.y = n.by + Math.cos(t * 0.35 + n.phase * 1.3) * n.drift * 0.8;
  });

  edges.forEach((e) => {
    const A = e.a === -1 ? { x: cx, y: cy } : nodes[e.a];
    const B = nodes[e.b];
    if (!A || !B) return;
    const hot = hovered !== null && (e.a === hovered || e.b === hovered);
    const dim = netFilter !== 'all' && nodes[e.b].status !== netFilter && (e.a === -1 || nodes[e.a].status !== netFilter);
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.strokeStyle = hot ? 'rgba(96,165,250,.45)' : dim ? 'rgba(59,130,246,.035)' : 'rgba(59,130,246,.11)';
    ctx.lineWidth = hot ? 1.5 : 1;
    ctx.stroke();
    // partícula viajando
    if (!dim) {
      const p = (t * 0.28 + e.b * 0.17) % 1;
      const x = A.x + (B.x - A.x) * p;
      const y = A.y + (B.y - A.y) * p;
      ctx.beginPath();
      ctx.arc(x, y, hot ? 2.2 : 1.6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(147,197,253,${(hot ? 0.95 : 0.55) * Math.sin(p * Math.PI)})`;
      ctx.fill();
    }
  });

  // núcleo
  const pulse = 0.5 + Math.sin(t * 1.6) * 0.5;
  const coreR = (30 + pulse * 2) * zoom;
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.arc(cx, cy, coreR + 16 + k * 20 + pulse * 6, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(59,130,246,${0.13 - k * 0.035})`;
    ctx.stroke();
  }
  const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.6);
  cg.addColorStop(0, 'rgba(96,165,250,.42)');
  cg.addColorStop(1, 'rgba(59,130,246,0)');
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 2.6, 0, Math.PI * 2);
  ctx.fillStyle = cg;
  ctx.fill();
  const coreFill = ctx.createRadialGradient(cx - 8, cy - 8, 2, cx, cy, coreR);
  coreFill.addColorStop(0, '#bfdbfe');
  coreFill.addColorStop(0.55, '#3b82f6');
  coreFill.addColorStop(1, '#5b21b6');
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.fillStyle = coreFill;
  ctx.shadowBlur = 32;
  ctx.shadowColor = 'rgba(59,130,246,.75)';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.font = '600 10px Inter,sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('CEREBRO', cx, cy);

  // nodos
  nodes.forEach((n, i) => {
    const isHover = hovered === i;
    const col = COLOR[n.status] ?? COLOR.pending;
    const r = (n.r + (isHover ? 3 : 0)) * zoom;
    const dim = netFilter !== 'all' && n.status !== netFilter;
    ctx.globalAlpha = dim ? 0.2 : 1;
    const hg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3.2);
    hg.addColorStop(0, `rgba(${col.rgb.join(',')},${isHover ? 0.34 : 0.2})`);
    hg.addColorStop(1, `rgba(${col.rgb.join(',')},0)`);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r * 3.2, 0, Math.PI * 2);
    ctx.fillStyle = hg;
    ctx.fill();
    const bg = ctx.createRadialGradient(n.x - r * 0.35, n.y - r * 0.35, 1, n.x, n.y, r);
    bg.addColorStop(0, '#2b3145');
    bg.addColorStop(1, '#12161f');
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${col.rgb.join(',')},${isHover ? 0.95 : 0.62})`;
    ctx.lineWidth = isHover ? 2.2 : 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(n.x, n.y, r * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = col.hex;
    ctx.shadowBlur = 12;
    ctx.shadowColor = col.hex;
    ctx.fill();
    ctx.shadowBlur = 0;
    if (n.status === 'index') {
      const pr = r + 6 + ((t * 22) % 26);
      ctx.beginPath();
      ctx.arc(n.x, n.y, pr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(251,191,36,${Math.max(0, 1 - ((t * 22) % 26) / 26) * 0.5})`;
      ctx.stroke();
    }
    ctx.font = `${isHover ? 600 : 500} 11.5px Inter,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = isHover ? '#fff' : 'rgba(200,207,222,.72)';
    ctx.fillText(n.name, n.x, n.y + r + 9);
    ctx.globalAlpha = 1;
  });
}
requestAnimationFrame(draw);

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left,
    my = e.clientY - rect.top;
  let found: number | null = null;
  nodes.forEach((n, i) => {
    if (netFilter !== 'all' && n.status !== netFilter) return;
    if (Math.hypot(mx - n.x, my - n.y) <= n.r * zoom + 10) found = i;
  });
  hovered = found;
  canvas.style.cursor = found !== null ? 'pointer' : 'default';
  if (found !== null) {
    const n = nodes[found];
    const f = folders[found];
    const label = { ok: 'Vectorizada', index: 'Indexando', pending: 'Pendiente' }[n.status];
    tip.innerHTML = `<b>${esc(n.name)}</b>
      <div class="row"><span>Archivos</span><span>${nf(n.files)}</span></div>
      ${f ? `<div class="row"><span>Ruta</span><span style="font-family:var(--mono);font-size:10px">${esc(f.path)}</span></div>` : ''}
      <div class="row"><span>Estado</span><span style="color:${COLOR[n.status]?.hex ?? '#888'}">${label}</span></div>`;
    tip.style.left = `${n.x + n.r * zoom + 16}px`;
    tip.style.top = `${n.y - 34}px`;
    tip.classList.add('show');
  } else tip.classList.remove('show');
});
canvas.addEventListener('mouseleave', () => {
  hovered = null;
  tip.classList.remove('show');
});
$('#zoomIn').addEventListener('click', () => (zoom = Math.min(1.8, zoom + 0.15)));
$('#zoomOut').addEventListener('click', () => (zoom = Math.max(0.55, zoom - 0.15)));
$('#resetNet').addEventListener('click', () => {
  zoom = 1;
  t0 = performance.now();
});
$$('.home-filters .chip').forEach((ch) =>
  ch.addEventListener('click', () => {
    $$('.home-filters .chip').forEach((x) => x.classList.remove('active'));
    ch.classList.add('active');
    netFilter = (ch as HTMLElement).dataset.filter!;
  })
);
window.addEventListener('resize', () => setTimeout(scheduleCanvasResize, 120));

/* ═════════ Carpetas ═════════ */
const STATUS_LABEL: Record<string, [string, string]> = {
  ready: ['Vectorizado', 'ok'],
  indexing: ['Indexando', 'index'],
  scanning: ['Escaneando', 'index'],
  pending: ['Pendiente', 'pending'],
  error: ['Error', 'pending'],
  disabled: ['Desactivada', 'pending']
};

function renderFolders(): void {
  const tree = $('#folderTree');
  $('#navFolders').textContent = String(folders.length);
  $('#folderCount').textContent = `· ${folders.length} carpetas · ${nf(folders.reduce((a, f) => a + f.fileCount, 0))} archivos`;
  if (folders.length === 0) {
    tree.innerHTML = '<p style="font-size:12px;color:var(--muted2);padding:16px">Aún no hay carpetas. Pulsa «Añadir carpeta» para empezar a construir el cerebro.</p>';
    return;
  }
  tree.innerHTML = folders
    .map((f) => {
      const [label, cls] = STATUS_LABEL[f.status] ?? ['…', 'pending'];
      const pct = f.fileCount > 0 ? Math.round((f.indexedFiles / f.fileCount) * 100) : 0;
      return `<div class="tree-row root" data-id="${f.id}">
        <div class="folder-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.4.6L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>
        <div class="info"><b>${esc(f.name)}</b><span>${esc(f.path)}</span></div>
        <div class="meta">${nf(f.fileCount)} archivos<small>${bytes(f.totalBytes)}${f.fileCount > 0 ? ` · ${pct}%` : ''}</small></div>
        <span class="status ${cls}">${label}${f.status === 'indexing' && f.fileCount > 0 ? ` ${pct}%` : ''}</span>
        <button class="btn sm ghost" data-rm="${f.id}" title="Eliminar del cerebro (no borra archivos)">✕</button>
        <label class="switch"><input type="checkbox" data-toggle-folder="${f.id}" ${f.enabled ? 'checked' : ''}><span class="track"></span></label>
      </div>`;
    })
    .join('');

  tree.querySelectorAll('[data-rm]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = Number((b as HTMLElement).dataset.rm);
      const f = folders.find((x) => x.id === id);
      folders = await invoke('folders:remove', id);
      toast(`Carpeta eliminada: ${f?.name ?? id}`, 'info');
      renderFolders();
      buildGraph();
    })
  );
  tree.querySelectorAll('[data-toggle-folder]').forEach((inp) =>
    inp.addEventListener('change', async () => {
      const el = inp as HTMLInputElement;
      const id = Number(el.dataset.toggleFolder);
      folders = await invoke('folders:toggle', id, el.checked);
      toast(el.checked ? 'Carpeta activada · indexando' : 'Carpeta desactivada', 'info');
      renderFolders();
      buildGraph();
    })
  );
}

$('#btnAddFolder').addEventListener('click', async () => {
  try {
    let path: string | null = null;
    /* Siempre usamos el diálogo nativo de Electron si está disponible;
       si no (modo web), caemos al prompt como respaldo. */
    if (IS_WEB) {
      const raw = prompt('Ruta absoluta de la carpeta que quieres indexar:', '/home/');
      path = (raw ?? '').trim() || null;
    } else {
      path = await invoke<string | null>('folders:pick');
    }
    if (!path) return;
    folders = await invoke<FolderInfo[]>('folders:add', path);
    toast(`Carpeta añadida: ${path}`, 'ok');
    renderFolders();
    buildGraph();
    void refreshStats();
  } catch (e: any) {
    toast(`No se pudo añadir la carpeta: ${e.message}`, 'warn', 5000);
  }
});

/* Comportamiento */
function bindSwitch(id: string, key: string): void {
  const el = $<HTMLInputElement>(`#${id}`);
  el.addEventListener('change', async () => {
    settings = await invoke('settings:set', { behavior: { [key]: el.checked } });
    toast('Preferencia guardada', 'ok');
  });
}
bindSwitch('swAuto', 'autoIndex');
bindSwitch('swGitignore', 'respectGitignore');
bindSwitch('swHidden', 'ignoreHidden');
bindSwitch('swSymlinks', 'followSymlinks');
$('#selRescan').addEventListener('change', async () => {
  settings = await invoke('settings:set', { behavior: { rescanIntervalSec: Number(($('#selRescan') as HTMLSelectElement).value) } });
  toast('Intervalo de re-escaneo actualizado', 'ok');
});

/* ═════════ Tipos de archivo ═════════ */
let selectedExts: Set<string> = new Set();

function renderPresets(): void {
  $('#presetGrid').innerHTML = Object.entries(PRESETS)
    .map(
      ([key, p]) => `<button class="preset" data-preset="${key}">
        <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h12M4 18h8"/></svg></div>
        <b>${p.label}</b>
        <span>${p.exts.slice(0, 6).join(' ')}${p.exts.length > 6 ? ' …' : ''}</span>
      </button>`
    )
    .join('');
  $$('.preset').forEach((p) =>
    p.addEventListener('click', () => {
      selectedExts = new Set((PRESETS[(p as HTMLElement).dataset.preset!]?.exts ?? []).filter((e) => SUPPORTED_EXTS.includes(e)));
      renderExts();
      void saveExts();
      toast(`Preset aplicado · ${selectedExts.size} extensiones`, 'ok');
    })
  );
}

function renderExts(): void {
  $('#extGrid').innerHTML = EXTENSIONS.map((e) => {
    const on = selectedExts.has(e.ext);
    return `<label class="ext ${on ? 'on' : ''} ${e.supported ? '' : 'off'}" title="${e.supported ? '' : 'Próximamente'}">
      <input type="checkbox" ${on ? 'checked' : ''} ${e.supported ? '' : 'disabled'} data-ext="${e.ext}">
      <span class="box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
      <span class="nm">${e.ext}</span>
      ${e.supported ? '' : '<span class="sz">próx.</span>'}
    </label>`;
  }).join('');
  $('#extCount').textContent = `· ${selectedExts.size} seleccionadas`;
  $$('.ext input').forEach((inp) =>
    inp.addEventListener('change', () => {
      const el = inp as HTMLInputElement;
      const ext = el.dataset.ext!;
      el.checked ? selectedExts.add(ext) : selectedExts.delete(ext);
      (el.closest('.ext') as HTMLElement).classList.toggle('on', el.checked);
      $$('.preset').forEach((x) => x.classList.remove('active'));
      $('#extCount').textContent = `· ${selectedExts.size} seleccionadas`;
      void saveExts();
    })
  );
}

async function saveExts(): Promise<void> {
  settings = await invoke('settings:set', { types: { extensions: [...selectedExts] } });
}

$('#btnExtAll').addEventListener('click', () => {
  selectedExts = new Set(SUPPORTED_EXTS);
  renderExts();
  void saveExts();
  toast('Todas las extensiones activadas', 'ok');
});
$('#btnExtNone').addEventListener('click', () => {
  selectedExts = new Set();
  renderExts();
  void saveExts();
  toast('Ninguna extensión activada', 'warn');
});

let excludeTimer: number | undefined;
$('#inExcludes').addEventListener('change', () => {
  clearTimeout(excludeTimer);
  excludeTimer = window.setTimeout(async () => {
    const raw = ($<HTMLInputElement>('#inExcludes').value || '').split(',').map((s) => s.trim()).filter(Boolean);
    settings = await invoke('settings:set', { behavior: { excludePatterns: raw } });
    toast('Patrones de exclusión guardados', 'ok');
  }, 400);
});
$('#inMaxSize').addEventListener('change', async () => {
  const v = Math.max(1, Number($<HTMLInputElement>('#inMaxSize').value) || 10);
  settings = await invoke('settings:set', { behavior: { maxFileSizeMB: v } });
  toast('Tamaño máximo actualizado', 'ok');
});

/* ═════════ Modelos ═════════ */
async function loadModels(): Promise<void> {
  const [catalog, hw, snap] = await Promise.all([
    invoke<any[]>('model:catalog'),
    invoke<any>('hardware'),
    invoke<any>('snapshot')
  ]);
  rec = snap.recommendation as ModelRecommendation;

  // banner de recomendación
  const rm = catalog.find((m: any) => m.id === rec!.modelId);
  $('#recBox').querySelector('span')!.innerHTML =
    `<b>Te recomendamos ${esc(rec!.model.id)}</b> (dim ${rec!.model.dim} · ~${rec!.model.downloadMB} MB · ${rec!.model.lang}). ${esc(rec!.reason)}<br>` +
    `<span style="color:var(--muted3)">${hw.cpuCores} núcleos · ${hw.ramTotalGB} GB RAM${hw.gpus.length ? ` · ${esc(hw.gpus[0].name)}` : ''}</span>`;

  $('#modelList').innerHTML = catalog
    .map((m: any) => {
      const active = m.active;
      return `<div class="model-card ${active ? 'active' : ''}" data-model="${m.id}">
        <div class="ico">${m.id.slice(0, 3).toUpperCase()}</div>
        <div class="info">
          <b>${esc(m.label)}${active ? ' · activo' : ''}</b>
          <span>${m.dim} dim · ${m.ctx} tokens · ${m.paramsM} M params · ${esc(m.lang)} · local</span>
          <span style="color:var(--muted3);font-size:10.5px;margin-top:3px">${esc(m.desc)}</span>
          <span style="margin-top:6px;display:inline-block" class="tag ${m.downloaded ? 'green' : 'amber'}">${m.downloaded ? `descargado (${m.downloadedMB} MB)` : `descargar ~${m.downloadMB} MB`}</span>
          ${m.id === rec!.modelId ? '<span class="tag purple" style="margin-top:6px;margin-left:6px">recomendado</span>' : ''}
        </div>
        <div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
      </div>`;
    })
    .join('');

  $$('.model-card').forEach((c) =>
    c.addEventListener('click', () => void selectModel((c as HTMLElement).dataset.model!))
  );
}

async function selectModel(id: string): Promise<void> {
  const res = await invoke<{ ok: boolean; needsDownload: boolean; error?: string }>('model:select', id);
  if (!res.ok) {
    toast(res.error ?? 'Error', 'warn');
    return;
  }
  activeModelId = id;
  toast(`Modelo ${id} activo`, 'ok');
  if (res.needsDownload) {
    toast('Descargando modelo (solo la primera vez)…', 'info', 4000);
    const dl = await invoke<{ ok: boolean; error?: string }>('model:download', id);
    if (dl.ok) {
      toast('Modelo descargado y listo', 'ok');
      await loadModels();
    } else {
      toast(`Descarga fallida: ${dl.error}`, 'warn', 6000);
    }
  } else {
    await loadModels();
  }
  updateStatusbar();
}

/* Sliders */
function bindRange(id: string, outId: string, fmt: (v: string) => string, patch: () => any): void {
  const r = $<HTMLInputElement>(`#${id}`);
  const o = document.getElementById(outId)!;
  const upd = () => (o.textContent = fmt(r.value));
  r.addEventListener('change', async () => {
    settings = await invoke('settings:set', patch());
    toast('Ajuste guardado · puede requerir re-indexación', 'info');
  });
  r.addEventListener('input', upd);
  upd();
}
bindRange('rChunk', 'vChunk', (v) => `${v} tokens`, () => ({ chunk: { size: Number($<HTMLInputElement>('#rChunk').value) } }));
bindRange('rOverlap', 'vOverlap', (v) => `${v} tokens`, () => ({ chunk: { overlap: Number($<HTMLInputElement>('#rOverlap').value) } }));
bindRange('rMin', 'vMin', (v) => `${v} tokens`, () => ({ chunk: { min: Number($<HTMLInputElement>('#rMin').value) } }));
bindRange('rTopK', 'vTopK', (v) => v, () => ({ retrieval: { topK: Number($<HTMLInputElement>('#rTopK').value) } }));
bindRange('rThr', 'vThr', (v) => parseFloat(v).toFixed(2), () => ({ retrieval: { threshold: parseFloat($<HTMLInputElement>('#rThr').value) } }));
bindRange('rHyb', 'vHyb', (v) => `${v}%`, () => ({ retrieval: { hybrid: Number($<HTMLInputElement>('#rHyb').value) } }));

/* ═════════ Playground (búsqueda real) ═════════ */
const chatBox = $<HTMLTextAreaElement>('#chatBox');
const chatScroll = $('#chatScroll');

chatBox.addEventListener('input', () => {
  chatBox.style.height = 'auto';
  chatBox.style.height = `${Math.min(120, chatBox.scrollHeight)}px`;
});
chatBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendChat();
  }
});
$('#btnSend').addEventListener('click', () => void sendChat());

function addUserMsg(txt: string): void {
  const u = document.createElement('div');
  u.className = 'chat-msg user';
  u.innerHTML = `<div class="av">TÚ</div><div class="bubble"><p>${esc(txt)}</p></div>`;
  chatScroll.appendChild(u);
}

function addBotMsg(html: string): void {
  const b = document.createElement('div');
  b.className = 'chat-msg bot';
  b.innerHTML = `<div class="av">C</div><div class="bubble">${html}</div>`;
  chatScroll.appendChild(b);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

async function sendChat(): Promise<void> {
  const txt = chatBox.value.trim();
  if (!txt) return;
  addUserMsg(txt);
  chatBox.value = '';
  chatBox.style.height = 'auto';
  chatScroll.scrollTop = chatScroll.scrollHeight;

  const thinking = document.createElement('div');
  thinking.className = 'chat-msg bot';
  thinking.innerHTML = '<div class="av">C</div><div class="bubble"><p>Buscando en el cerebro…</p></div>';
  chatScroll.appendChild(thinking);
  chatScroll.scrollTop = chatScroll.scrollHeight;

  try {
    const res = await invoke<SearchResult>('search', txt);
    thinking.remove();
    searchLatency = res.ms;
    if (res.resultados.length === 0) {
      addBotMsg(
        `<p>No encontré fragmentos relevantes para <code>${esc(txt)}</code>. Puede que esas carpetas aún no estén indexadas o que el umbral de similitud sea alto.</p>`
      );
      return;
    }
    const sources = res.resultados
      .map(
        (r) => `<div class="source" data-path="${esc(r.ruta)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
          <span class="p" title="${esc(r.ruta)}">${esc(r.nombre)} · frag ${r.chunk + 1}</span><span class="sc">${r.score.toFixed(2)}</span>
        </div>`
      )
      .join('');
    const previews = res.resultados
      .slice(0, 3)
      .map((r) => `<p style="font-size:12px;color:var(--muted);border-left:2px solid var(--border2);padding-left:10px;margin-top:8px">${esc(r.texto.slice(0, 260))}${r.texto.length > 260 ? '…' : ''}</p>`)
      .join('');
    addBotMsg(
      `<p>Encontré <b>${res.resultados.length} fragmentos</b> en ${res.ms} ms:</p>
       ${previews}
       <div class="sources"><div class="ttl">Fuentes · pulsa para abrir en el explorador</div>${sources}</div>`
    );
    chatScroll.querySelectorAll('.source').forEach((s) =>
      s.addEventListener('click', () => {
        const p = (s as HTMLElement).dataset.path ?? '';
        void invoke('open-path', p).catch(() => {
          // en el navegador no hay explorador de archivos: copiamos la ruta
          navigator.clipboard
            .writeText(p)
            .then(
              () => toast(`Ruta copiada: ${p}`, 'info'),
              () => toast(`Ruta: ${p}`, 'info')
            );
        });
      })
    );
  } catch (e: any) {
    thinking.remove();
    addBotMsg(`<p style="color:var(--red)">Error en la búsqueda: ${esc(e.message ?? String(e))}</p>`);
  }
}

/* ═════════ Conexión ═════════ */
function renderConnection(): void {
  if (!serverSt) return;
  const { url, mcpUrl, token, authMode } = serverSt;
  $('#mcpUrl').textContent = mcpUrl;
  $('#apiUrl').textContent = `${url}/v1`;
  $('#serverTag').innerHTML = `<span class="dot" style="width:6px;height:6px"></span>Servidor activo · :${serverSt.port}`;
  $('#connHost').textContent = serverSt.allowLan ? '0.0.0.0 (LAN)' : '127.0.0.1';

  const authHeader = authMode === 'bearer' ? `\n      "headers": { "Authorization": "Bearer ${token}" },` : '';
  const mcpCfg = `// En Claude Desktop / Claude Code / Cursor: claude_desktop_config.json
{
  "mcpServers": {
    "cerebro-local": {${authMode === 'bearer' ? `\n      "headers": { "Authorization": "Bearer ${token}" },` : ''}
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`;
  $('#mcpCode').innerHTML = `${esc(mcpCfg)}<button class="copy-mini" data-copy="mcpCode">Copiar</button>`;

  const apiEx = `# Buscar en el cerebro
curl -X POST ${url}/v1/buscar \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "arquitectura del proyecto", "top_k": 5}'

# Listar carpetas
curl ${url}/v1/carpetas -H "Authorization: Bearer ${token}"

# Leer un documento (solo dentro de carpetas indexadas)
curl "${url}/v1/documento?path=/ruta/al/archivo.md&limit=4000" \\
  -H "Authorization: Bearer ${token}"`;
  $('#apiCode').innerHTML = `${esc(apiEx)}<button class="copy-mini" data-copy="apiCode">Copiar</button>`;
  void authHeader;

  $$('.copy-mini').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const src = document.getElementById((b as HTMLElement).dataset.copy!);
      const clone = src!.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.copy-mini').forEach((n) => n.remove());
      copyText(clone.textContent!.trim(), 'Configuración copiada');
      b.textContent = 'Copiado';
      setTimeout(() => (b.textContent = 'Copiar'), 1600);
    };
  });
}

/* Prompt copiable para agentes */
function agentPromptMcp(): string {
  const { mcpUrl, token, authMode } = serverSt!;
  return `# Conexión MCP — Cerebro Local

Estás conectado a un cerebro de conocimiento local mediante el protocolo MCP.
Todo el contenido proviene de carpetas del equipo del usuario y se sirve en localhost.

## Servidor
- URL:         ${mcpUrl}
- Transporte:  Streamable HTTP${authMode === 'bearer' ? `\n- Auth:        Bearer ${token}` : ''}

## Configuración del cliente
{
  "mcpServers": {
    "cerebro-local": {${authMode === 'bearer' ? `\n      "headers": { "Authorization": "Bearer ${token}" },` : ''}
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}

## Herramientas disponibles
- buscar(query, top_k?, carpetas?, tipos?) → fragmentos con ruta, score y texto
- listar_carpetas() → carpetas vectorizadas y su estado
- leer_documento(path, offset?, limit?) → contenido de un documento concreto
- estado_index() → progreso de la vectorización

## Reglas de uso
1. Antes de responder cualquier pregunta sobre archivos, proyectos o notas del usuario, llama SIEMPRE a "buscar". No respondas de memoria.
2. Cita la ruta exacta del archivo y el fragmento utilizado en cada afirmación.
3. Si "buscar" no devuelve resultados relevantes, dilo explícitamente; no inventes contenido.
4. Nunca inventes rutas de archivo. Usa únicamente las devueltas por las herramientas.
5. Si la pregunta es amplia, usa top_k = 12 y refina después.
6. El acceso es de solo lectura: no intentes escribir, mover ni borrar archivos.`;
}

function agentPromptApi(): string {
  const { url, token, authMode } = serverSt!;
  const auth = authMode === 'bearer' ? `\n- Auth:       Bearer ${token}` : '';
  return `# Conexión API — Cerebro Local

Estás conectado a un cerebro de conocimiento local mediante su API HTTP.

## Servidor
- Base URL:   ${url}/v1${auth}

## Endpoints
POST /v1/buscar    { "query", "top_k"?, "carpetas"?, "tipos"? } → { "resultados": [ { ruta, score, texto } ] }
GET  /v1/carpetas  → { "carpetas": [ { nombre, ruta, archivos, estado } ] }
GET  /v1/documento?path=...&offset=...&limit=... → { ruta, contenido, total }
GET  /v1/estado    → progreso de la vectorización

## Ejemplo
curl -X POST ${url}/v1/buscar \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "arquitectura del proyecto", "top_k": 5}'

## Reglas de uso
1. Antes de responder preguntas sobre los archivos del usuario, consulta SIEMPRE POST /v1/buscar. No respondas de memoria.
2. Cita la ruta exacta y el fragmento usado en cada afirmación.
3. No inventes rutas ni contenido: si no hay resultados, dilo.
4. El acceso es de solo lectura.`;
}

$$('[data-copy-agent]').forEach((b) =>
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    copyText((b as HTMLElement).dataset.copyAgent === 'mcp' ? agentPromptMcp() : agentPromptApi(), 'Prompt para agente copiado');
  })
);

/* ═════════ Registro ═════════ */
const logBox = $('#logBox');
function addLogLine(e: LogEntry): void {
  const d = new Date(e.ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="t">${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span><span class="lvl ${e.level}">${e.level}</span><span class="msg">${e.msg.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`;
  logBox.appendChild(line);
  while (logBox.children.length > 220) logBox.removeChild(logBox.firstChild!);
  logBox.scrollTop = logBox.scrollHeight;
}
$('#btnClearLogs').addEventListener('click', async () => {
  await invoke('logs:clear');
  logBox.innerHTML = '';
  toast('Registro limpiado', 'info');
});

/* ═════════ Resumen ═════════ */
async function refreshStats(): Promise<void> {
  const st = await invoke<any>('stats');
  $('#kFolders').textContent = nf(st.folders);
  $('#kFiles').textContent = nf(st.files);
  $('#kChunks').textContent = nf(st.chunks);
  $('#kFilesDelta').textContent = st.pending > 0 ? `${nf(st.pending)} pendientes` : 'todo indexado';
  $('#kLatency').textContent = searchLatency > 0 ? String(searchLatency) : '—';
  $('#hsFiles').textContent = nf(st.files);
  $('#hsChunks').textContent = nf(st.chunks);
  $('#hsBytes').textContent = bytes(st.bytes);
  $('#stBytes').textContent = bytes(st.bytes);

  // distribución
  const dist = st.extDistribution as { ext: string; count: number }[];
  if (dist.length > 0) {
    const total = dist.reduce((a, d) => a + d.count, 0) || 1;
    const colors = ['#3b82f6', '#22d3ee', '#34d399', '#fbbf24', '#f87171', '#232a3a'];
    $('#distBox').innerHTML = `<div class="donut-legend">${dist
      .map(
        (d, i) => `<div class="li"><i style="background:${colors[i % colors.length]}"></i><span class="n">${esc(d.ext)}</span><span class="v">${nf(d.count)} · ${Math.round((d.count / total) * 100)}%</span></div>`
      )
      .join('')}</div>`;
  }

  // cola
  const q = progress;
  const queueBox = $('#queueBox');
  if (q && q.running) {
    $('#queueTag').textContent = q.phase;
    const pct = q.filesTotal > 0 ? Math.round((q.filesDone / q.filesTotal) * 100) : 0;
    queueBox.innerHTML = `<div class="queue-item">
      <div class="nm"><b>${esc(q.folderName ?? 'Cerebro')}</b><span>${esc(q.message)}</span>
      <div class="progress"><i style="width:${pct}%"></i></div></div>
      <span class="status index">${pct}%</span></div>`;
  } else {
    $('#queueTag').textContent = 'inactivo';
    queueBox.innerHTML = '<p style="font-size:12px;color:var(--muted2);padding:12px 0">Sin actividad. Añade carpetas o pulsa «Re-indexar».</p>';
  }
}

$('#btnPauseAll').addEventListener('click', async () => {
  if (progress?.running && !progress.paused) {
    await invoke('index:pause');
    toast('Indexación pausada', 'info');
  } else if (progress?.paused) {
    await invoke('index:resume');
    toast('Indexación reanudada', 'ok');
  } else {
    toast('No hay nada en marcha', 'info');
  }
});
$('#btnReindex').addEventListener('click', async () => {
  await invoke('index:full');
  toast('Re-indexación completa iniciada', 'ok');
});
$('#btnRescan').addEventListener('click', async () => {
  await invoke('index:start', {});
  toast('Re-escaneando carpetas…', 'info');
});

/* ═════════ Ajustes ═════════ */
function renderSettings(): void {
  if (!settings) return;
  $<HTMLInputElement>('#inPort').value = String(settings.server.port);
  $<HTMLInputElement>('#inToken').value = settings.server.token;
  $<HTMLInputElement>('#swAuth').checked = settings.server.authMode === 'bearer';
  $<HTMLInputElement>('#swLan').checked = settings.server.allowLan;
  $<HTMLInputElement>('#inMaxSize').value = String(settings.behavior.maxFileSizeMB);
  $<HTMLInputElement>('#inExcludes').value = settings.behavior.excludePatterns.join(', ');
  $<HTMLInputElement>('#swAuto').checked = settings.behavior.autoIndex;
  $<HTMLInputElement>('#swGitignore').checked = settings.behavior.respectGitignore;
  $<HTMLInputElement>('#swHidden').checked = settings.behavior.ignoreHidden;
  $<HTMLInputElement>('#swSymlinks').checked = settings.behavior.followSymlinks;
  ($('#selRescan') as HTMLSelectElement).value = String(settings.behavior.rescanIntervalSec);
  $<HTMLInputElement>('#rChunk').value = String(settings.chunk.size);
  $<HTMLInputElement>('#rOverlap').value = String(settings.chunk.overlap);
  $<HTMLInputElement>('#rMin').value = String(settings.chunk.min);
  $<HTMLInputElement>('#rTopK').value = String(settings.retrieval.topK);
  $<HTMLInputElement>('#rThr').value = String(settings.retrieval.threshold);
  $<HTMLInputElement>('#rHyb').value = String(settings.retrieval.hybrid);
  $<HTMLInputElement>('#rChunk').dispatchEvent(new Event('input'));
  $<HTMLInputElement>('#rOverlap').dispatchEvent(new Event('input'));
  $<HTMLInputElement>('#rMin').dispatchEvent(new Event('input'));
  $<HTMLInputElement>('#rTopK').dispatchEvent(new Event('input'));
  $<HTMLInputElement>('#rThr').dispatchEvent(new Event('input'));
  $<HTMLInputElement>('#rHyb').dispatchEvent(new Event('input'));
  selectedExts = new Set(settings.types.extensions);
  renderPresets();
  renderExts();
}

$('#inPort').addEventListener('change', async () => {
  const v = Math.max(1024, Math.min(65535, Number($<HTMLInputElement>('#inPort').value) || 7433));
  settings = await invoke('settings:set', { server: { port: v } });
  toast('Puerto actualizado', 'ok');
});
$('#swAuth').addEventListener('change', async (e) => {
  settings = await invoke('settings:set', { server: { authMode: (e.target as HTMLInputElement).checked ? 'bearer' : 'none' } });
  toast('Modo de autenticación actualizado', 'ok');
});
$('#swLan').addEventListener('change', async (e) => {
  settings = await invoke('settings:set', { server: { allowLan: (e.target as HTMLInputElement).checked } });
  toast('Acceso LAN actualizado', 'ok');
});
$('#btnRegenToken').addEventListener('click', async () => {
  serverSt = await invoke<ServerStatus>('token:regenerate');
  settings = await invoke('settings:get');
  renderSettings();
  renderConnection();
  toast('Token regenerado · actualiza la configuración de tus agentes', 'ok', 4000);
});

function renderHardware(hw: any): void {
  $('#hwCpu').textContent = `${hw.cpuModel} · ${hw.cpuCores} núcleos @ ${hw.cpuSpeedMHz} MHz`;
  $('#hwRam').textContent = `${hw.ramTotalGB} GB (${hw.ramFreeGB} GB libres)`;
  $('#hwGpu').textContent = hw.gpus.length ? hw.gpus.map((g: any) => `${g.name} · ${Math.round(g.vramMB / 1024)} GB`).join(' / ') : 'Sin GPU dedicada detectada';
  $('#hwOs').textContent = `${hw.osVersion} · ${hw.arch}`;
  $<HTMLInputElement>('#inDataDir').value = hw.dataDir;
}

/* ═════════ Statusbar ═════════ */
function updateStatusbar(): void {
  $('#sbConn').textContent = serverSt?.running ? `Conectado a 127.0.0.1:${serverSt.port}` : 'Servidor caído';
  $('#sbDot').style.background = serverSt?.running ? '' : 'var(--red)';
  $('#sideStatus').textContent = serverSt?.running ? `Servidor activo · :${serverSt.port}` : 'Servidor caído';
  $('#sideDot').className = `dot ${serverSt?.running ? '' : 'off'}`;
  const devTag = computeDevice === 'cpu' ? '' : ' · GPU';
  $('#sbModel').textContent = (activeModelId ?? settings?.embedding.modelId ?? '—') + devTag;
  $('#sbVersion').textContent = APP_VERSION;
  const sbIndex = $('#sbIndex');
  if (progress?.running) {
    sbIndex.hidden = false;
    sbIndex.innerHTML = `⚡ ${esc(progress.message)}`;
    $('#navLive').hidden = false;
  } else {
    sbIndex.hidden = true;
    $('#navLive').hidden = true;
  }
}

/* ═════════ Eventos push ═════════ */
api.onEvent((ev: CerebroEvent) => {
  switch (ev.type) {
    case 'log':
      addLogLine(ev.entry);
      break;
    case 'index:progress':
      progress = ev.progress;
      updateStatusbar();
      if (document.querySelector('#view-resumen.active')) void refreshStats();
      break;
    case 'folders:changed':
      void invoke<FolderInfo[]>('folders:list').then((fs) => {
        folders = fs;
        renderFolders();
        buildGraph();
      });
      break;
    case 'stats:changed':
      if (document.querySelector('#view-resumen.active') || document.querySelector('#view-home.active')) void refreshStats();
      break;
    case 'server:status':
      serverSt = ev.status;
      renderConnection();
      updateStatusbar();
      break;
    case 'model:download':
      if (ev.status === 'done') toast(`Modelo ${ev.modelId} listo`, 'ok');
      break;
    case 'clients:changed':
      if (document.querySelector('#view-clientes.active')) void refreshClients();
      else void refreshClientBadge();
      break;
  }
});

/* ═════════ Clientes ═════════ */
let clients: ClientInfo[] = [];

async function refreshClients(): Promise<void> {
  try {
    clients = await invoke<ClientInfo[]>('clients:list');
  } catch {
    return;
  }
  renderClients();
  void refreshClientBadge();
}

async function refreshClientBadge(): Promise<void> {
  try {
    clients = await invoke<ClientInfo[]>('clients:list');
  } catch {
    return;
  }
  const act = clients.filter((c) => c.active).length;
  const badge = $('#navClients');
  badge.hidden = clients.length === 0;
  badge.textContent = String(act);
  badge.classList.toggle('live', act > 0);
  const tag = $('#clientsActiveTag');
  if (tag) tag.innerHTML = `<span class="dot" style="width:6px;height:6px"></span>${act} activos`;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return new Date(ts).toLocaleString('es-ES');
}

function renderClients(): void {
  const box = $('#clientsBox');
  if (clients.length === 0) {
    box.innerHTML =
      '<p class="clients-empty">Nadie ha conectado todavía. Configura un agente en la vista «Conexión» y aparecerá aquí en cuanto haga su primera petición.</p>';
    return;
  }
  box.innerHTML = `<table class="clients-table">
    <thead><tr><th>Cliente</th><th>Tipo</th><th>Origen</th><th>Peticiones</th><th>Última actividad</th></tr></thead>
    <tbody>${clients
      .map(
        (c) => `<tr>
      <td><div class="cname"><span class="cdot ${c.active ? 'on' : 'off'}"></span><b>${esc(c.name)}</b></div></td>
      <td><span class="tag ${c.kind === 'MCP' ? 'purple' : 'cyan'}">${c.kind}</span></td>
      <td class="mono">${esc(c.ip)}${c.lastTool ? ` · ${esc(c.lastTool)}` : ''}</td>
      <td>${nf(c.requests)}</td>
      <td>${ago(c.lastSeen)}</td>
    </tr>`
      )
      .join('')}</tbody></table>`;
}

/* refresco periódico cuando la vista está visible */
setInterval(() => {
  if (document.querySelector('#view-clientes.active')) void refreshClients();
}, 5000);

/* ═════════ Command palette ═════════ */
const CMDS: { g: string; i: string; v?: string; a?: string }[] = [
  { g: 'Navegación', i: 'Ir a Red neuronal', v: 'home' },
  { g: 'Navegación', i: 'Ir a Resumen', v: 'resumen' },
  { g: 'Navegación', i: 'Ir a Carpetas', v: 'carpetas' },
  { g: 'Navegación', i: 'Ir a Tipos de archivo', v: 'tipos' },
  { g: 'Navegación', i: 'Ir a Modelos', v: 'modelos' },
  { g: 'Navegación', i: 'Ir a Playground', v: 'playground' },
  { g: 'Navegación', i: 'Ir a Conexión', v: 'conexion' },
  { g: 'Navegación', i: 'Ir a Registro', v: 'registro' },
  { g: 'Navegación', i: 'Ir a Ajustes', v: 'ajustes' },
  { g: 'Acciones', i: 'Re-escanear carpetas', a: 'scan' },
  { g: 'Acciones', i: 'Re-indexar todo', a: 'full' },
  { g: 'Acciones', i: 'Copiar configuración MCP', a: 'mcp' },
  { g: 'Acciones', i: 'Copiar prompt MCP para agente', a: 'agent' }
];
const cmdk = $('#cmdk');
const cmdIn = $<HTMLInputElement>('#cmdkInput');
const cmdList = $('#cmdkList');
let cmdSel = 0;
let cmdItems: typeof CMDS = [];

function renderCmdk(filter = ''): void {
  cmdItems = CMDS.filter((c) => c.i.toLowerCase().includes(filter.toLowerCase()));
  cmdList.innerHTML = '';
  let lastG = '';
  cmdItems.forEach((c, idx) => {
    if (c.g !== lastG) {
      const g = document.createElement('div');
      g.className = 'cmdk-group';
      g.textContent = c.g;
      cmdList.appendChild(g);
      lastG = c.g;
    }
    const el = document.createElement('div');
    el.className = `cmdk-item ${idx === cmdSel ? 'sel' : ''}`;
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg><span>${c.i}</span>`;
    el.addEventListener('click', () => runCmd(c));
    cmdList.appendChild(el);
  });
}
function runCmd(c: (typeof CMDS)[0]): void {
  closeCmdk();
  if (c.v) go(c.v);
  else if (c.a === 'scan') void invoke('index:start', {}).then(() => toast('Re-escaneando…', 'info'));
  else if (c.a === 'full') void invoke('index:full').then(() => toast('Re-indexando todo…', 'info'));
  else if (c.a === 'mcp' && serverSt) copyText(JSON.stringify({ mcpServers: { 'cerebro-local': { type: 'http', url: serverSt.mcpUrl, ...(serverSt.authMode === 'bearer' ? { headers: { Authorization: `Bearer ${serverSt.token}` } } : {}) } } }, null, 2), 'Configuración MCP copiada');
  else if (c.a === 'agent') copyText(agentPromptMcp(), 'Prompt copiado');
}
function openCmdk(): void {
  cmdk.classList.add('show');
  cmdIn.value = '';
  cmdSel = 0;
  renderCmdk();
  setTimeout(() => cmdIn.focus(), 30);
}
function closeCmdk(): void {
  cmdk.classList.remove('show');
}
cmdIn.addEventListener('input', () => {
  cmdSel = 0;
  renderCmdk(cmdIn.value);
});
cmdk.addEventListener('click', (e) => {
  if (e.target === cmdk) closeCmdk();
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    cmdk.classList.contains('show') ? closeCmdk() : openCmdk();
    return;
  }
  if (!cmdk.classList.contains('show')) return;
  if (e.key === 'Escape') closeCmdk();
  else if (e.key === 'ArrowDown') {
    e.preventDefault();
    cmdSel = Math.min(cmdItems.length - 1, cmdSel + 1);
    renderCmdk(cmdIn.value);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cmdSel = Math.max(0, cmdSel - 1);
    renderCmdk(cmdIn.value);
  } else if (e.key === 'Enter' && cmdItems[cmdSel]) {
    e.preventDefault();
    runCmd(cmdItems[cmdSel]);
  }
});

/* Búsqueda global → playground */
$('#globalSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = ($<HTMLInputElement>('#globalSearch').value || '').trim();
    go('playground');
    if (v) {
      chatBox.value = v;
      void sendChat();
      $<HTMLInputElement>('#globalSearch').value = '';
    }
  }
});

/* ═════════ Arranque ═════════ */
async function boot(): Promise<void> {
  const snap = await invoke<any>('snapshot');
  settings = snap.settings;
  serverSt = snap.server;
  activeModelId = snap.activeModel?.id ?? null;
  computeDevice = snap.device ?? snap.activeModel?.device ?? 'cpu';

  renderSettings();
  renderHardware(snap.hardware);
  folders = await invoke<FolderInfo[]>('folders:list');
  renderFolders();
  buildGraph();
  scheduleCanvasResize();
  renderConnection();
  updateStatusbar();
  await loadModels();

  const logs = await invoke<LogEntry[]>('logs:tail', 60);
  logs.forEach(addLogLine);
  progress = await invoke('index:progress');
  updateStatusbar();
  await refreshStats();

  setInterval(() => void refreshStats(), 5000);
  void refreshClientBadge();
}

void (async function tryBoot() {
  let tries = 0;
  for (;;) {
    try {
      await boot();
      return;
    } catch (e: any) {
      tries += 1;
      toast(`Error de arranque: ${e.message} · reintento ${tries}/10`, 'warn', 4000);
      if (tries >= 10) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
})();
