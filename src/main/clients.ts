import type { ClientInfo } from '../shared/types';

/* Registro de clientes conectados al servicio.
   Cada cliente (agente MCP o app vía API REST) se identifica por su IP + User-Agent
   (o por el nombre del cliente MCP si lo declara en initialize). Se guarda en
   memoria: la app es un servicio local y el registro vive tanto como la sesión. */

const ACTIVE_WINDOW_MS = 60_000;

interface Entry {
  key: string;
  kind: 'MCP' | 'API';
  name: string;
  ip: string;
  userAgent: string;
  requests: number;
  firstSeen: number;
  lastSeen: number;
  lastTool: string | null;
}

export class ClientRegistry {
  private map = new Map<string, Entry>();

  /* Registra una petición. `name` solo se pasa en el initialize de MCP. */
  touch(opts: {
    kind: 'MCP' | 'API';
    ip: string;
    userAgent: string;
    name?: string | null;
    tool?: string | null;
  }): { entry: Entry; isNew: boolean } {
    const key = `${opts.kind}:${opts.ip}:${opts.userAgent}`;
    const now = Date.now();
    let e = this.map.get(key);
    const isNew = !e;
    if (!e) {
      e = {
        key,
        kind: opts.kind,
        name: opts.name?.trim() || `${opts.kind} · ${opts.userAgent.split(' ')[0] ?? 'desconocido'}`,
        ip: opts.ip,
        userAgent: opts.userAgent,
        requests: 0,
        firstSeen: now,
        lastSeen: now,
        lastTool: null
      };
      this.map.set(key, e);
    }
    e.requests++;
    e.lastSeen = now;
    if (opts.name?.trim()) e.name = opts.name.trim();
    if (opts.tool) e.lastTool = opts.tool;
    // cap: nunca más de 200 clientes conocidos (los viejos se caen primero)
    if (this.map.size > 200) {
      const oldest = [...this.map.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest && now - oldest.lastSeen > 5 * 60_000) this.map.delete(oldest.key);
    }
    return { entry: e, isNew };
  }

  list(): ClientInfo[] {
    const now = Date.now();
    return [...this.map.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((e) => ({
        key: e.key,
        kind: e.kind,
        name: e.name,
        ip: e.ip,
        userAgent: e.userAgent,
        requests: e.requests,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
        lastTool: e.lastTool,
        active: now - e.lastSeen < ACTIVE_WINDOW_MS
      }));
  }

  countActive(): number {
    const now = Date.now();
    return [...this.map.values()].filter((e) => now - e.lastSeen < ACTIVE_WINDOW_MS).length;
  }
}
