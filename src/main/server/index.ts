import express, { type Express, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CerebroDb } from '../db/database';
import { hybridSearch } from '../db/search';
import type { EmbeddingEngine } from '../models/engine';
import { getModel } from '../models/catalog';
import type { Indexer } from '../index/indexer';
import type { Logger } from '../logger';
import type { Settings } from '../../shared/types';
import { APP_VERSION } from '../../shared/version';

export interface ServerContext {
  db: CerebroDb;
  engine: EmbeddingEngine;
  indexer: Indexer;
  logger: Logger;
  getSettings: () => Settings;
  /* Despacho de canales de la UI web (mismos canales que el IPC de Electron) */
  dispatch?: (channel: string, args: unknown[]) => Promise<{ result?: unknown; error?: string }>;
  /* Suscripción a eventos push (para SSE /events) */
  onEvent?: (cb: (ev: unknown) => void) => () => void;
}

/* Dir donde está la UI compilada (dist/renderer); funciona empaquetado y con tsx */
function findUiDir(): string | null {
  const cands = [
    join(__dirname, '../renderer'), // empaquetado: dist/main/../renderer
    join(__dirname, '../../../dist/renderer') // desarrollo con tsx: src/main/server → dist/renderer
  ];
  for (const c of cands) {
    if (existsSync(join(c, 'index.html')) && existsSync(join(c, 'app.js'))) return c;
  }
  return null;
}

export class CerebroServer {
  private app: Express;
  private http: Server | null = null;
  private port = 0;
  private serverPort = 0;

  constructor(private ctx: ServerContext) {
    this.app = express();
    this.app.use(express.json({ limit: '2mb' }));
    this.app.use(this.authMiddleware.bind(this));
    this.registerRoutes();
  }

  /* ── Auth: Bearer token (o desactivada) ──────────────── */
  private authMiddleware(req: Request, res: Response, next: () => void): void {
    // /v1/salud es un ping público para comprobar que el servidor vive
    if (req.path === '/v1/salud') return next();
    // UI web, /bridge y /events no llevan token: es la interfaz local (el servidor
    // solo escucha en 127.0.0.1 salvo que el usuario active explícitamente allowLan)
    if (!req.path.startsWith('/v1') && !req.path.startsWith('/mcp')) return next();
    const s = this.ctx.getSettings();
    if (s.server.authMode !== 'bearer') return next();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string | undefined);
    if (token !== s.server.token) {
      res.status(401).json({ error: 'no autorizado: falta o es incorrecto el token (Authorization: Bearer …)' });
      return;
    }
    next();
  }

  private async embedQuery(query: string): Promise<Float32Array> {
    const model = getModel(this.ctx.getSettings().embedding.modelId ?? '');
    if (!model) throw new Error('No hay modelo de embeddings configurado');
    return this.ctx.engine.embedQuery(model, query);
  }

  private registerRoutes(): void {
    const app = this.app;
    const ctx = this.ctx;

    app.get('/v1/salud', (_req, res) => {
      res.json({ ok: true, nombre: 'Cerebro Local', version: APP_VERSION });
    });

    /* Búsqueda principal */
    app.post('/v1/buscar', async (req, res) => {
      try {
        const body = req.body ?? {};
        const query = String(body.query ?? '').trim();
        if (!query) {
          res.status(400).json({ error: 'Falta el campo "query"' });
          return;
        }
        const s = ctx.getSettings();
        const topK = Math.min(50, Math.max(1, Number(body.top_k ?? s.retrieval.topK)));
        const folderIds = Array.isArray(body.carpetas) && body.carpetas.length > 0 ? this.resolveFolders(body.carpetas) : undefined;
        const result = await hybridSearch(ctx.db, (q) => this.embedQuery(q), query, {
          topK,
          threshold: Number(body.umbral ?? s.retrieval.threshold),
          hybrid: Number(body.hibrido ?? s.retrieval.hybrid),
          folderIds,
          exts: Array.isArray(body.tipos) ? body.tipos : undefined
        });
        res.json(result);
      } catch (e: any) {
        ctx.logger.error(`API /v1/buscar: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });

    /* Carpetas indexadas */
    app.get('/v1/carpetas', (_req, res) => {
      res.json({ carpetas: ctx.db.listFolders() });
    });

    /* Estado general */
    app.get('/v1/estado', (_req, res) => {
      const st = ctx.db.dashboardStats();
      res.json({
        carpetas: st.folders,
        archivos: st.files,
        fragmentos: st.chunks,
        bytes: st.bytes,
        pendientes: st.pending,
        vectorizando: st.indexing > 0,
        modelo: ctx.getSettings().embedding.modelId,
        progreso: ctx.indexer.progress
      });
    });

    /* Lectura de documento (solo dentro de carpetas registradas) */
    app.get('/v1/documento', async (req, res) => {
      try {
        const path = String(req.query.path ?? '');
        const offset = Math.max(0, Number(req.query.offset ?? 0));
        const limit = Math.min(200_000, Math.max(100, Number(req.query.limit ?? 4000)));
        if (!path) {
          res.status(400).json({ error: 'Falta el parámetro "path"' });
          return;
        }
        if (!ctx.db.isPathInsideRegisteredFolder(path)) {
          res.status(403).json({ error: 'La ruta no pertenece a ninguna carpeta indexada' });
          return;
        }
        const raw = await fsp.readFile(path, 'utf8').catch(() => null);
        if (raw === null) {
          res.status(404).json({ error: 'Archivo no encontrado o ilegible' });
          return;
        }
        res.json({ ruta: path, total: raw.length, offset, contenido: raw.slice(offset, offset + limit) });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    /* Re-indexar bajo demanda */
    app.post('/v1/indexar', async (req, res) => {
      const full = req.body?.full === true;
      void ctx.indexer.start({ full });
      res.json({ ok: true, message: full ? 'Re-indexación completa iniciada' : 'Indexación iniciada' });
    });

    /* ── MCP (Streamable HTTP, estado sin sesión) ──────── */
    app.get('/mcp', (_req, res) => {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Método no disponible: use POST /mcp (Streamable HTTP)' },
        id: null
      });
    });

    const mcpHandler = async (req: Request, res: Response) => {
      try {
        const server = this.buildMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined // modo sin sesión: más simple y robusto para clientes locales
        });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e: any) {
        this.ctx.logger.error(`MCP: ${e.message}`);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: e.message },
            id: null
          });
        }
      }
    };
    app.post('/mcp', mcpHandler);
    app.delete('/mcp', mcpHandler);

    /* ── UI web (mismo servidor que la API) ───────────── */
    const uiDir = findUiDir();
    if (uiDir) {
      app.use(express.static(uiDir, { index: 'index.html' }));
    }

    /* Puente de la UI web → mismos canales que el IPC de Electron */
    app.post('/bridge', async (req, res) => {
      const body = req.body ?? {};
      if (!this.ctx.dispatch) {
        res.status(500).json({ error: 'Puente no disponible en este modo' });
        return;
      }
      const out = await this.ctx.dispatch(String(body.channel ?? ''), Array.isArray(body.args) ? body.args : []);
      res.json(out);
    });

    /* Eventos push (SSE) → la UI web recibe los mismos eventos que el IPC */
    app.get('/events', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': conectado\n\n');
      const send = (ev: unknown): void => {
        try {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        } catch {
          /* cliente caído */
        }
      };
      const unsub = this.ctx.onEvent ? this.ctx.onEvent(send) : () => {};
      const ka = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* cliente caído */
        }
      }, 15_000);
      const close = (): void => {
        clearInterval(ka);
        try {
          unsub();
        } catch {
          /* noop */
        }
      };
      req.on('close', close);
      res.on('close', close);
    });

    /* SPA fallback: cualquier GET no-API sirve la UI */
    app.use((req, res, next) => {
      const p = req.path;
      const isApi = p.startsWith('/v1') || p.startsWith('/mcp') || p.startsWith('/bridge') || p.startsWith('/events');
      if (req.method === 'GET' && !isApi && uiDir) {
        res.sendFile(join(uiDir, 'index.html'));
        return;
      }
      next();
    });

    app.use((_req, res) => {
      res.status(404).json({ error: 'Ruta no encontrada. Disponible: /v1/* y /mcp' });
    });
  }

  /* Nombres o rutas de carpeta → ids */
  private resolveFolders(refs: any[]): number[] | undefined {
    const folders = this.ctx.db.listFolders();
    const ids: number[] = [];
    for (const r of refs) {
      const key = String(r);
      const f = folders.find((x) => x.id === Number(key) || x.name === key || x.path === key);
      if (f) ids.push(f.id);
    }
    return ids.length > 0 ? ids : undefined;
  }

  private buildMcpServer(): McpServer {
    const ctx = this.ctx;
    const server = new McpServer({ name: 'cerebro-local', version: APP_VERSION });

    server.registerTool(
      'buscar',
      {
        description:
          'Busca fragmentos relevantes en las carpetas indexadas del usuario. Devuelve ruta, puntuación de similitud y texto. Úsala SIEMPRE antes de responder preguntas sobre archivos, proyectos, notas o documentos del usuario.',
        inputSchema: {
          query: z.string().describe('Consulta en lenguaje natural'),
          top_k: z.number().int().min(1).max(30).optional().describe('Número de fragmentos (por defecto 8; usa más para preguntas amplias)'),
          carpetas: z.array(z.string()).optional().describe('Filtrar por nombre o ruta de carpeta'),
          tipos: z.array(z.string()).optional().describe('Filtrar por extensiones, p. ej. [".md", ".pdf"]')
        }
      },
      async ({ query, top_k, carpetas, tipos }) => {
        const s = ctx.getSettings();
        const folderIds = carpetas && carpetas.length > 0 ? this.resolveFolders(carpetas) : undefined;
        const result = await hybridSearch(
          ctx.db,
          (q) => this.embedQuery(q),
          query,
          {
            topK: top_k ?? s.retrieval.topK,
            threshold: s.retrieval.threshold,
            hybrid: s.retrieval.hybrid,
            folderIds,
            exts: tipos
          }
        );
        if (result.resultados.length === 0) {
          return { content: [{ type: 'text', text: `Sin resultados para "${query}". No inventes contenido: dilo explícitamente.` }] };
        }
        const texto = result.resultados
          .map(
            (r, i) =>
              `[${i + 1}] ${r.ruta} (similitud ${r.score.toFixed(2)}, fragmento ${r.chunk + 1})\n${r.texto}`
          )
          .join('\n\n---\n\n');
        return { content: [{ type: 'text', text: `${result.resultados.length} fragmentos · ${result.ms} ms\n\n${texto}` }] };
      }
    );

    server.registerTool(
      'listar_carpetas',
      {
        description: 'Lista las carpetas vectorizadas del cerebro local y su estado de indexación.',
        inputSchema: {}
      },
      async () => {
        const folders = ctx.db.listFolders();
        const texto =
          folders.length === 0
            ? 'No hay carpetas configuradas todavía.'
            : folders
                .map(
                  (f) =>
                    `• ${f.name} (${f.path}) — ${f.enabled ? f.status : 'desactivada'} · ${f.fileCount} archivos · ${f.indexedFiles} indexados`
                )
                .join('\n');
        return { content: [{ type: 'text', text: texto }] };
      }
    );

    server.registerTool(
      'leer_documento',
      {
        description:
          'Devuelve el contenido de un documento concreto (o un rango indicando offset/limit). Usa la ruta exacta devuelta por "buscar".',
        inputSchema: {
          path: z.string().describe('Ruta absoluta del archivo'),
          offset: z.number().int().min(0).optional().describe('Carácter de inicio'),
          limit: z.number().int().min(100).max(200000).optional().describe('Máximo de caracteres por lectura')
        }
      },
      async ({ path, offset, limit }) => {
        if (!ctx.db.isPathInsideRegisteredFolder(path)) {
          return { content: [{ type: 'text', text: `Denegado: "${path}" no pertenece a ninguna carpeta indexada.` }], isError: true };
        }
        const raw = await fsp.readFile(path, 'utf8').catch(() => null);
        if (raw === null) {
          return { content: [{ type: 'text', text: `No se pudo leer "${path}".` }], isError: true };
        }
        const off = offset ?? 0;
        const lim = Math.min(200_000, limit ?? 4000);
        const slice = raw.slice(off, off + lim);
        return {
          content: [{ type: 'text', text: `${path} · ${raw.length} caracteres totales · offset ${off}\n\n${slice}` }]
        };
      }
    );

    server.registerTool(
      'estado_index',
      {
        description: 'Progreso actual de la vectorización del cerebro local.',
        inputSchema: {}
      },
      async () => {
        const st = ctx.db.dashboardStats();
        const p = ctx.indexer.progress;
        return {
          content: [
            {
              type: 'text',
              text: `Carpetas: ${st.folders} · Archivos: ${st.files} · Fragmentos: ${st.chunks}\nPendientes: ${st.pending} · Modelo: ${ctx.getSettings().embedding.modelId ?? 'sin configurar'}\nMotor: ${p.running ? `${p.phase} — ${p.message}` : 'inactivo'}`
            }
          ]
        };
      }
    );

    return server;
  }

  get listeningPort(): number {
    return this.port;
  }

  async start(): Promise<number> {
    const s = this.ctx.getSettings();
    const host = s.server.allowLan ? '0.0.0.0' : '127.0.0.1';
    /* El callback de 'listening' y el de 'error' pueden solaparse: sin este guard,
       start() resolvía con 0 antes de probar el puerto alternativo y
       serverStatus() caía al puerto de config (7433), apuntando a otro servidor. */
    let settled = false;
    const boundPort = (srv: Server): number => {
      const addy = srv.address();
      return addy && typeof addy === 'object' && 'port' in addy ? addy.port : 0;
    };

    return new Promise<number>((resolve, reject) => {
      const attempt = (wanted: number, isRetry: boolean): void => {
        const srv = this.app.listen(wanted, host, () => {
          this.http = srv;
          const port = boundPort(srv);
          if (port <= 0 || settled) return; // nunca resolvemos con 0
          settled = true;
          this.port = port;
          this.serverPort = port;
          const label = isRetry ? 'puerto alternativo' : 'API /v1 · MCP /mcp';
          this.ctx.logger.ok(`Servidor escuchando en http://${host}:${port} (${label})`);
          resolve(port);
        });
        srv.on('error', (err: any) => {
          if (settled) return;
          if (err.code === 'EADDRINUSE' && !isRetry) {
            this.ctx.logger.warn(`Puerto ${wanted} ocupado · probando puerto libre`);
            srv.close();
            attempt(0, true);
          } else {
            settled = true;
            reject(err);
          }
        });
      };
      attempt(s.server.port, false);
    });
  }

  async stop(): Promise<void> {
    if (!this.http) return;
    await new Promise<void>((resolve) => this.http!.close(() => resolve()));
    this.http = null;
  }
}
