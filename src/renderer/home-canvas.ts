/* Lienzo infinito de carpetas: pan/zoom con inercia, cartas arrastrables,
   inclinación 3D al pasar el ratón, aristas animadas, partículas y minimapa. */
import type { FolderInfo } from '../shared/types';

type StatusKey = 'ok' | 'index' | 'pending' | 'error';

type HomeCanvasOptions = {
  stage: HTMLElement;
  world: HTMLElement;
  canvas: HTMLCanvasElement;
  minimap: HTMLCanvasElement;
  hint?: HTMLElement | null;
  onAddFolder: () => void;
  onOpenFolders: () => void;
};

type Card = {
  id: number;
  el: HTMLElement;
  body: HTMLElement;
  x: number;
  y: number;
  status: StatusKey;
  sig: string;
  data: FolderInfo;
};

type SavedPos = Record<string, { x: number; y: number }>;
type SavedView = { x: number; y: number; z: number };

const TAU = Math.PI * 2;
const GRID = 46;
const STORE_POS = 'cerebro.home.positions.v1';
const STORE_VIEW = 'cerebro.home.view.v1';

const FOLDER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.4.6L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const GRIP_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>';
const ARROW_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

const META: Record<StatusKey, { label: string; hint: string; rgb: string; dot: string }> = {
  ok: { label: 'Vectorizada', hint: 'Lista para agentes', rgb: '52,211,153', dot: '#34d399' },
  index: { label: 'Indexando', hint: 'Vectorizando…', rgb: '251,191,36', dot: '#fbbf24' },
  pending: { label: 'Pendiente', hint: 'En cola', rgb: '100,116,139', dot: '#64748b' },
  error: { label: 'Error', hint: 'Revisar carpeta', rgb: '248,113,113', dot: '#f87171' }
};

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const fmt = (n: number): string => Math.round(n).toLocaleString('es-ES');
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function fmtBytes(n: number): string {
  if (n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* almacenamiento restringido */
  }
}

function statusOf(f: FolderInfo): StatusKey {
  if (!f.enabled) return 'pending';
  if (f.status === 'ready') return 'ok';
  if (f.status === 'indexing' || f.status === 'scanning') return 'index';
  if (f.status === 'error') return 'error';
  return 'pending';
}

function pctOf(f: FolderInfo, key: StatusKey): number {
  if (!f.enabled || f.fileCount <= 0) return 0;
  if (key === 'ok') return 100;
  return clamp(Math.round((f.indexedFiles / f.fileCount) * 100), 0, 100);
}

function matches(key: StatusKey, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'pending') return key === 'pending' || key === 'error';
  return key === filter;
}

export class HomeCanvas {
  private readonly stage: HTMLElement;
  private readonly world: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly mini: HTMLCanvasElement;
  private readonly mctx: CanvasRenderingContext2D;

  private W = 0;
  private H = 0;
  private dpr = 1;
  private camX = 0;
  private camY = 0;
  private zoom = 1;
  private tCamX = 0;
  private tCamY = 0;
  private tZoom = 1;

  private cards: Card[] = [];
  private folders: FolderInfo[] = [];
  private emptyEl: HTMLElement | null = null;
  private hoverId: number | null = null;
  private filter = 'all';
  private firstFit = true;
  private positions: SavedPos;

  private dragging: Card | null = null;
  private dragOffset = { x: 0, y: 0 };
  private dragStart = { x: 0, y: 0 };
  private dragMoved = false;
  private pending: FolderInfo[] | null = null;

  private panning = false;
  private panStart = { x: 0, y: 0, camX: 0, camY: 0 };
  private lastP = { x: 0, y: 0, t: 0, vx: 0, vy: 0 };
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private resizePending = false;

  private raf = 0;
  private t0 = performance.now();
  private lastMini = 0;
  private miniScale = 1;
  private miniOx = 0;
  private miniOy = 0;

  private dust = Array.from({ length: 64 }, () => ({
    x: Math.random(),
    y: Math.random(),
    s: 0.6 + Math.random() * 1.5,
    v: 0.004 + Math.random() * 0.012,
    p: Math.random() * TAU
  }));

  constructor(private readonly opts: HomeCanvasOptions) {
    this.stage = opts.stage;
    this.world = opts.world;
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext('2d')!;
    this.mini = opts.minimap;
    this.mctx = this.mini.getContext('2d')!;
    this.positions = loadJSON<SavedPos>(STORE_POS, {});

    const v = loadJSON<SavedView | null>(STORE_VIEW, null);
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) && v.z > 0.2) {
      this.camX = this.tCamX = v.x;
      this.camY = this.tCamY = v.y;
      this.zoom = this.tZoom = clamp(v.z, 0.38, 2.2);
      this.firstFit = false;
    }

    this.stage.addEventListener('pointerdown', this.onStageDown);
    this.stage.addEventListener('pointermove', this.onStageMove);
    this.stage.addEventListener('pointerup', this.onStageUp);
    this.stage.addEventListener('pointercancel', this.onStageUp);
    this.stage.addEventListener('wheel', this.onWheel, { passive: false });
    this.mini.addEventListener('pointerdown', this.onMiniDown);
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('beforeunload', () => this.saveView());

    document.getElementById('zoomIn')?.addEventListener('click', () => this.zoomCenter(1.18));
    document.getElementById('zoomOut')?.addEventListener('click', () => this.zoomCenter(0.85));
    document.getElementById('resetNet')?.addEventListener('click', () => this.fit(true));

    document.querySelectorAll<HTMLElement>('.home-filters .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.home-filters .chip').forEach((x) => x.classList.remove('active'));
        chip.classList.add('active');
        this.setFilter(chip.dataset.filter ?? 'all');
      });
    });

    this.raf = requestAnimationFrame(this.tick);
  }

  /* ═════════ API ═════════ */

  setFolders(folders: FolderInfo[]): void {
    if (this.dragging) {
      this.pending = folders;
      return;
    }
    this.folders = folders;
    if (this.emptyEl) {
      this.emptyEl.remove();
      this.emptyEl = null;
    }

    const prev = new Map(this.cards.map((c) => [c.id, c]));
    const next: Card[] = [];
    folders.forEach((f, i) => {
      let card = prev.get(f.id);
      if (!card) {
        const saved = this.positions[String(f.id)];
        const pos =
          saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : this.spiral(i);
        card = this.createCard(f, pos, i);
      }
      this.updateCard(card, f);
      next.push(card);
    });
    for (const old of this.cards) if (!next.includes(old)) old.el.remove();
    this.cards = next;

    if (folders.length === 0) this.createEmpty();

    const coreFiles = document.getElementById('coreFiles');
    const coreFolders = document.getElementById('coreFolders');
    if (coreFiles) coreFiles.textContent = fmt(folders.reduce((a, f) => a + f.fileCount, 0));
    if (coreFolders) coreFolders.textContent = String(folders.length);

    if (this.firstFit) this.fit(false);
    this.applyCamera();
    this.drawMini();
  }

  setFilter(filter: string): void {
    this.filter = filter;
    this.world.dataset.filter = filter;
    for (const c of this.cards) {
      const dim = filter !== 'all' && !matches(c.status, filter);
      c.el.classList.toggle('dim', dim);
    }
    this.drawMini();
  }

  resize(): void {
    const r = this.stage.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) {
      if (!this.resizePending) {
        this.resizePending = true;
        setTimeout(() => {
          this.resizePending = false;
          this.resize();
        }, 160);
      }
      return;
    }
    this.W = r.width;
    this.H = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(this.W * this.dpr);
    this.canvas.height = Math.floor(this.H * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const mr = this.mini.getBoundingClientRect();
    if (mr.width > 4 && mr.height > 4) {
      this.mini.width = Math.floor(mr.width * this.dpr);
      this.mini.height = Math.floor(mr.height * this.dpr);
    }

    if (this.firstFit) this.fit(false);
    this.applyCamera();
  }

  fit(animate = true): void {
    if (this.W < 10) return;
    let minX = -120;
    let maxX = 120;
    let minY = -120;
    let maxY = 120;
    for (const c of this.cards) {
      minX = Math.min(minX, c.x - 165);
      maxX = Math.max(maxX, c.x + 165);
      minY = Math.min(minY, c.y - 115);
      maxY = Math.max(maxY, c.y + 115);
    }
    if (this.emptyEl) maxY = Math.max(maxY, 330);

    const bw = Math.max(260, maxX - minX);
    const bh = Math.max(240, maxY - minY);
    const z = clamp(Math.min((this.W - 180) / bw, (this.H - 190) / bh), 0.4, 1.08);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    this.tZoom = z;
    this.tCamX = -cx * z;
    this.tCamY = -cy * z + 4;

    if (!animate || this.firstFit) {
      this.zoom = z;
      this.camX = this.tCamX;
      this.camY = this.tCamY;
      this.applyCamera();
    }
    this.firstFit = false;
    this.saveView();
  }

  /* ═════════ Cámara ═════════ */

  private applyCamera(): void {
    this.world.style.transform = `translate(${this.W / 2 + this.camX}px, ${
      this.H / 2 + this.camY
    }px) scale(${this.zoom})`;
  }

  private toWorld(sx: number, sy: number, target = false): { x: number; y: number } {
    const z = target ? this.tZoom : this.zoom;
    const cx = target ? this.tCamX : this.camX;
    const cy = target ? this.tCamY : this.camY;
    return { x: (sx - this.W / 2 - cx) / z, y: (sy - this.H / 2 - cy) / z };
  }

  /* Convierte coordenadas de cliente a coordenadas locales del escenario. */
  private stageLocal(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  private zoomCenter(factor: number): void {
    if (this.W < 10) return;
    const p = this.toWorld(this.W / 2, this.H / 2, true);
    const nz = clamp(this.tZoom * factor, 0.38, 2.2);
    this.tZoom = nz;
    this.tCamX = -p.x * nz;
    this.tCamY = -p.y * nz;
    this.hintHide();
    this.queueSave();
  }

  private focus(card: Card): void {
    const nz = clamp(Math.max(this.tZoom, 1.02), 0.38, 2.2);
    this.tZoom = nz;
    this.tCamX = -card.x * nz;
    this.tCamY = -card.y * nz;
    this.hintHide();
    this.queueSave();
  }

  private saveView(): void {
    saveJSON(STORE_VIEW, { x: this.camX, y: this.camY, z: this.zoom });
  }

  private queueSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveView(), 350);
  }

  private hintHide(): void {
    this.opts.hint?.classList.add('hide');
  }

  /* ═════════ Interacción: lienzo ═════════ */

  private onStageDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('.node-card') || t.closest('button')) return;
    this.panning = true;
    this.panStart = { x: e.clientX, y: e.clientY, camX: this.camX, camY: this.camY };
    this.lastP = { x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0 };
    this.stage.classList.add('panning');
    this.stage.setPointerCapture(e.pointerId);
    this.hintHide();
  };

  private onStageMove = (e: PointerEvent): void => {
    if (!this.panning) return;
    const now = performance.now();
    const dt = Math.max(8, now - this.lastP.t);
    this.lastP.vx = (e.clientX - this.lastP.x) / dt;
    this.lastP.vy = (e.clientY - this.lastP.y) / dt;
    this.lastP.x = e.clientX;
    this.lastP.y = e.clientY;
    this.lastP.t = now;

    this.camX = this.tCamX = this.panStart.camX + (e.clientX - this.panStart.x);
    this.camY = this.tCamY = this.panStart.camY + (e.clientY - this.panStart.y);
    this.applyCamera();
  };

  private onStageUp = (e: PointerEvent): void => {
    if (!this.panning) return;
    this.panning = false;
    this.stage.classList.remove('panning');
    try {
      this.stage.releasePointerCapture(e.pointerId);
    } catch {
      /* captura ya liberada */
    }
    this.tCamX = this.camX + clamp(this.lastP.vx * 150, -280, 280);
    this.tCamY = this.camY + clamp(this.lastP.vy * 150, -280, 280);
    this.saveView();
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.W < 10) return;
    const factor = clamp(Math.exp(-e.deltaY * 0.0015), 0.82, 1.22);
    const nz = clamp(this.tZoom * factor, 0.38, 2.2);
    const local = this.stageLocal(e.clientX, e.clientY);
    const p = this.toWorld(local.x, local.y, true);
    this.tZoom = nz;
    this.tCamX = local.x - this.W / 2 - p.x * nz;
    this.tCamY = local.y - this.H / 2 - p.y * nz;
    this.hintHide();
    this.queueSave();
  };

  /* ═════════ Interacción: cartas ═════════ */

  private createCard(f: FolderInfo, pos: { x: number; y: number }, i: number): Card {
    const el = document.createElement('article');
    el.className = 'node-card';
    el.dataset.id = String(f.id);
    el.tabIndex = 0;
    el.style.setProperty('--in', `${Math.min(i * 70, 560)}ms`);
    el.style.setProperty('--d', `${((i * 1.37) % 7).toFixed(2)}s`);
    el.innerHTML = '<div class="node-float"><div class="node-body"></div></div>';
    const body = el.querySelector('.node-body') as HTMLElement;
    const card: Card = {
      id: f.id,
      el,
      body,
      x: pos.x,
      y: pos.y,
      status: 'pending',
      sig: '',
      data: f
    };
    this.place(card);
    this.world.appendChild(el);
    this.bindCard(card);
    return card;
  }

  private place(card: Card): void {
    card.el.style.transform = `translate3d(${card.x}px, ${card.y}px, 0) translate(-50%, -50%)`;
  }

  private updateCard(card: Card, f: FolderInfo): void {
    const key = statusOf(f);
    card.data = f;
    card.status = key;
    card.el.dataset.status = key;
    const sig = [f.name, f.path, f.status, f.enabled, f.fileCount, f.indexedFiles, f.totalBytes].join('|');
    if (sig !== card.sig) {
      card.sig = sig;
      this.paint(card, f, key);
    }
  }

  private paint(card: Card, f: FolderInfo, key: StatusKey): void {
    const pct = pctOf(f, key);
    const label = f.enabled ? META[key].label : 'Desactivada';
    const hint = f.enabled ? META[key].hint : 'Pausada';
    card.body.innerHTML = `
      <div class="node-shine"></div>
      <div class="node-top">
        <div class="node-ico">${FOLDER_SVG}</div>
        <span class="node-state"><i></i>${esc(label)}</span>
        <span class="node-grip" title="Arrastrar para mover">${GRIP_SVG}</span>
      </div>
      <h3 class="node-name" title="${esc(f.name)}">${esc(f.name)}</h3>
      <p class="node-path" title="${esc(f.path)}">${esc(f.path)}</p>
      <div class="node-metrics">
        <div><b>${fmt(f.fileCount)}</b><span>archivos</span></div>
        <div><b>${fmtBytes(f.totalBytes)}</b><span>origen</span></div>
        <div><b>${pct}%</b><span>indexado</span></div>
      </div>
      <div class="node-bar"><i style="width:${pct}%"></i></div>
      <div class="node-foot">
        <span class="node-chip">${esc(hint)}</span>
        <button class="node-open" type="button" tabindex="-1">Abrir ${ARROW_SVG}</button>
      </div>`;
  }

  private bindCard(card: Card): void {
    const el = card.el;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('button')) return;
      e.stopPropagation();
      this.dragging = card;
      this.dragMoved = false;
      this.dragStart = { x: e.clientX, y: e.clientY };
      const start = this.stageLocal(e.clientX, e.clientY);
      const w = this.toWorld(start.x, start.y);
      this.dragOffset = { x: card.x - w.x, y: card.y - w.y };
      el.classList.add('dragging');
      el.setPointerCapture(e.pointerId);
      this.hintHide();
    });

    el.addEventListener('pointermove', (e) => {
      if (this.dragging === card) {
        if (Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y) > 4) {
          this.dragMoved = true;
        }
        const local = this.stageLocal(e.clientX, e.clientY);
        const w = this.toWorld(local.x, local.y);
        card.x = w.x + this.dragOffset.x;
        card.y = w.y + this.dragOffset.y;
        this.place(card);
        return;
      }
      if (e.pointerType === 'touch') return;
      const r = card.body.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      card.body.style.setProperty('--ry', `${(px * 10).toFixed(2)}deg`);
      card.body.style.setProperty('--rx', `${(-py * 8).toFixed(2)}deg`);
      card.body.style.setProperty('--mx', `${((px + 0.5) * 100).toFixed(1)}%`);
      card.body.style.setProperty('--my', `${((py + 0.5) * 100).toFixed(1)}%`);
    });

    const end = (e: PointerEvent): void => {
      if (this.dragging !== card) return;
      this.dragging = null;
      el.classList.remove('dragging');
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* captura ya liberada */
      }
      this.positions[String(card.id)] = { x: card.x, y: card.y };
      saveJSON(STORE_POS, this.positions);
      const onButton = Boolean((e.target as HTMLElement).closest('button'));
      if (!this.dragMoved && !onButton) this.focus(card);
      this.drawMini();
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        this.setFolders(p);
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('pointerenter', () => {
      this.hoverId = card.id;
      el.classList.add('hot');
    });
    el.addEventListener('pointerleave', () => {
      if (this.hoverId === card.id) this.hoverId = null;
      el.classList.remove('hot');
      card.body.style.setProperty('--rx', '0deg');
      card.body.style.setProperty('--ry', '0deg');
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.focus(card);
      }
    });

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.node-open')) {
        e.stopPropagation();
        this.opts.onOpenFolders();
      }
    });
  }

  private createEmpty(): void {
    const el = document.createElement('article');
    el.className = 'node-card empty-card';
    el.style.transform = 'translate3d(0px, 210px, 0) translate(-50%, -50%)';
    el.innerHTML = `
      <div class="node-float">
        <div class="node-body">
          <div class="empty-plus">+</div>
          <b class="empty-title">Tu lienzo está vacío</b>
          <span class="empty-sub">Añade una carpeta y aparecerá aquí como una carta flotante.</span>
          <button class="node-open empty-btn" type="button">Elegir carpeta ${ARROW_SVG}</button>
        </div>
      </div>`;
    el.querySelector('.empty-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.opts.onAddFolder();
    });
    this.world.appendChild(el);
    this.emptyEl = el;
  }

  private spiral(i: number): { x: number; y: number } {
    const a = i * 2.399963229728653 + 0.35;
    const r = 225 + 92 * Math.sqrt(i);
    return { x: Math.cos(a) * r * 1.24, y: Math.sin(a) * r * 0.74 };
  }

  private isDim(c: Card): boolean {
    return this.filter !== 'all' && !matches(c.status, this.filter);
  }

  /* ═════════ Bucle ═════════ */

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    if (document.hidden || this.W < 10) return;

    const k = 0.17;
    let changed = false;
    if (Math.abs(this.tCamX - this.camX) > 0.05 || Math.abs(this.tCamY - this.camY) > 0.05) {
      this.camX += (this.tCamX - this.camX) * k;
      this.camY += (this.tCamY - this.camY) * k;
      changed = true;
    } else {
      this.camX = this.tCamX;
      this.camY = this.tCamY;
    }
    if (Math.abs(this.tZoom - this.zoom) > 0.0004) {
      this.zoom += (this.tZoom - this.zoom) * k;
      changed = true;
    } else {
      this.zoom = this.tZoom;
    }
    if (changed) this.applyCamera();

    this.draw(now);
    if (now - this.lastMini > 120) {
      this.drawMini();
      this.lastMini = now;
    }
  };

  /* ═════════ Dibujo ═════════ */

  private draw(now: number): void {
    const ctx = this.ctx;
    const W = this.W;
    const H = this.H;
    const t = (now - this.t0) / 1000;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Nebulosa de fondo con deriva lenta
    const g1x = W * 0.3 + Math.sin(t * 0.07) * 50;
    const g1y = H * 0.32 + Math.cos(t * 0.09) * 34;
    const g1 = ctx.createRadialGradient(g1x, g1y, 0, g1x, g1y, Math.max(W, H) * 0.55);
    g1.addColorStop(0, 'rgba(37,99,235,.11)');
    g1.addColorStop(0.5, 'rgba(30,64,175,.035)');
    g1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, W, H);

    const g2x = W * 0.82 + Math.cos(t * 0.06) * 44;
    const g2y = H * 0.78 + Math.sin(t * 0.08) * 30;
    const g2 = ctx.createRadialGradient(g2x, g2y, 0, g2x, g2y, Math.max(W, H) * 0.48);
    g2.addColorStop(0, 'rgba(34,211,238,.07)');
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H);

    // Polvo parallax
    for (const d of this.dust) {
      const x = (((d.x * W + this.camX * 0.025 + Math.sin(t * d.v + d.p) * 22) % W) + W) % W;
      const y = (((d.y * H + this.camY * 0.02 + Math.cos(t * d.v * 0.8 + d.p) * 16) % H) + H) % H;
      ctx.globalAlpha = 0.1 + 0.18 * (0.5 + 0.5 * Math.sin(t * 0.8 + d.p));
      ctx.fillStyle = '#93c5fd';
      ctx.fillRect(x, y, d.s, d.s);
    }
    ctx.globalAlpha = 1;

    // Viñeta
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.46)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(W / 2 + this.camX, H / 2 + this.camY);
    ctx.scale(this.zoom, this.zoom);

    this.drawGrid(ctx);
    this.drawEdges(ctx, t);
    this.drawCore(ctx, t);

    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const minX = -(this.W / 2 + this.camX) / this.zoom;
    const maxX = (this.W / 2 - this.camX) / this.zoom;
    const minY = -(this.H / 2 + this.camY) / this.zoom;
    const maxY = (this.H / 2 - this.camY) / this.zoom;
    const x0 = Math.floor(minX / GRID) * GRID;
    const y0 = Math.floor(minY / GRID) * GRID;

    ctx.beginPath();
    for (let x = x0; x < maxX; x += GRID) {
      for (let y = y0; y < maxY; y += GRID) {
        const ix = Math.round(x / GRID);
        const iy = Math.round(y / GRID);
        const r = (ix * 7 + iy * 13) % 17 === 0 ? 1.7 : 1.0;
        ctx.moveTo(x + r / this.zoom, y);
        ctx.arc(x, y, r / this.zoom, 0, TAU);
      }
    }
    ctx.fillStyle = 'rgba(120,150,210,.17)';
    ctx.fill();
  }

  private drawEdges(ctx: CanvasRenderingContext2D, t: number): void {
    const hot = this.hoverId;

    // Hilos tenues entre carpetas vecinas
    if (this.cards.length > 1) {
      for (let i = 0; i < this.cards.length; i++) {
        const a = this.cards[i];
        const b = this.cards[(i + 1) % this.cards.length];
        if (this.isDim(a) || this.isDim(b)) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = 'rgba(96,165,250,.055)';
        ctx.lineWidth = 1 / this.zoom;
        ctx.stroke();
      }
    }

    this.cards.forEach((c, i) => {
      if (this.isDim(c)) return;
      const meta = META[c.status];
      const isHot = hot === c.id;
      const mx = c.x * 0.5 - c.y * 0.16;
      const my = c.y * 0.5 + c.x * 0.16;

      const grad = ctx.createLinearGradient(0, 0, c.x, c.y);
      grad.addColorStop(0, `rgba(96,165,250,${isHot ? 0.85 : 0.16})`);
      grad.addColorStop(1, `rgba(${meta.rgb},${isHot ? 0.9 : 0.3})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = (isHot ? 1.8 : 0.9) / this.zoom;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(mx, my, c.x, c.y);
      ctx.stroke();

      if (isHot) {
        ctx.save();
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 6 / this.zoom;
        ctx.stroke();
        ctx.restore();
      }

      const parts = isHot ? 3 : 1;
      for (let k = 0; k < parts; k++) {
        const p = (t * 0.16 + i * 0.23 + k * 0.33) % 1;
        const q = 1 - p;
        const px = 2 * q * p * mx + p * p * c.x;
        const py = 2 * q * p * my + p * p * c.y;
        ctx.beginPath();
        ctx.arc(px, py, (isHot ? 2.2 : 1.5) / this.zoom, 0, TAU);
        ctx.fillStyle = `rgba(${meta.rgb},${Math.sin(p * Math.PI) * (isHot ? 0.95 : 0.5)})`;
        ctx.fill();
      }
    });
  }

  private drawCore(ctx: CanvasRenderingContext2D, t: number): void {
    const pulse = 0.5 + Math.sin(t * 1.4) * 0.5;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 250);
    glow.addColorStop(0, `rgba(59,130,246,${0.16 + pulse * 0.08})`);
    glow.addColorStop(0.5, 'rgba(34,211,238,.045)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, 250, 0, TAU);
    ctx.fill();

    for (let k = 0; k < 3; k++) {
      const p = ((t * 0.13 + k / 3) % 1);
      ctx.beginPath();
      ctx.arc(0, 0, 66 + p * 230, 0, TAU);
      ctx.strokeStyle = `rgba(96,165,250,${(1 - p) * 0.16})`;
      ctx.lineWidth = 1 / this.zoom;
      ctx.stroke();
    }
  }

  /* ═════════ Minimapa ═════════ */

  private worldRect(): { x: number; y: number; w: number; h: number } {
    return {
      x: -(this.W / 2 + this.camX) / this.zoom,
      y: -(this.H / 2 + this.camY) / this.zoom,
      w: this.W / this.zoom,
      h: this.H / this.zoom
    };
  }

  private drawMini(): void {
    const w = this.mini.clientWidth;
    const h = this.mini.clientHeight;
    if (!w || !h || this.W < 10) return;
    if (this.mini.width !== Math.floor(w * this.dpr)) {
      this.mini.width = Math.floor(w * this.dpr);
      this.mini.height = Math.floor(h * this.dpr);
    }
    const ctx = this.mctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const view = this.worldRect();
    let minX = Math.min(0, view.x);
    let maxX = Math.max(0, view.x + view.w);
    let minY = Math.min(0, view.y);
    let maxY = Math.max(0, view.y + view.h);
    for (const c of this.cards) {
      minX = Math.min(minX, c.x - 130);
      maxX = Math.max(maxX, c.x + 130);
      minY = Math.min(minY, c.y - 90);
      maxY = Math.max(maxY, c.y + 90);
    }
    const pad = 26;
    minX -= pad;
    maxX += pad;
    minY -= pad;
    maxY += pad;

    const sc = Math.min((w - 12) / Math.max(1, maxX - minX), (h - 12) / Math.max(1, maxY - minY));
    const ox = w / 2 - ((minX + maxX) / 2) * sc;
    const oy = h / 2 - ((minY + maxY) / 2) * sc;
    this.miniScale = sc;
    this.miniOx = ox;
    this.miniOy = oy;

    ctx.fillStyle = '#60a5fa';
    ctx.beginPath();
    ctx.arc(ox, oy, 3, 0, TAU);
    ctx.fill();

    for (const c of this.cards) {
      ctx.fillStyle = META[c.status].dot;
      ctx.beginPath();
      ctx.arc(ox + c.x * sc, oy + c.y * sc, 2.5, 0, TAU);
      ctx.fill();
    }

    ctx.strokeStyle = 'rgba(147,197,253,.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + view.x * sc, oy + view.y * sc, view.w * sc, view.h * sc);
  }

  private onMiniDown = (e: PointerEvent): void => {
    e.stopPropagation();
    if (!this.miniScale) return;
    const r = this.mini.getBoundingClientRect();
    const wx = (e.clientX - r.left - this.miniOx) / this.miniScale;
    const wy = (e.clientY - r.top - this.miniOy) / this.miniScale;
    this.tCamX = -wx * this.tZoom;
    this.tCamY = -wy * this.tZoom;
    this.hintHide();
    this.queueSave();
  };
}
