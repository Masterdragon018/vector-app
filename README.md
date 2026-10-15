# 🧠 Cerebro Local

**Vectoriza tus carpetas y conéctalas a tus agentes mediante MCP o API — 100 % local.**

Cerebro Local es una aplicación de escritorio (Windows y Linux) que convierte las carpetas que tú elijas en un cerebro de conocimiento vectorial. Tus agentes de IA (Claude Desktop, Claude Code, Cursor, Windsurf, cualquier cliente MCP o vía API REST) pueden consultar ese conocimiento con rutas exactas y citas verificables — sin que nada salga de tu equipo.

## ✅ Estado actual (versión 0.3.0)

- **Modo web + Electron**: `npm start` arranca la UI en el navegador (http://127.0.0.1:PUERTO) **o** abre la app Electron clásica. El backend es el mismo: Node + SQLite + sqlite-vec + ONNX.
- **Aceleración por GPU**: si tienes una GPU NVIDIA con el runtime CUDA disponible, los embeddings se ejecutan en la gráfica (~14× más rápido que en CPU en una GTX 1660 Ti). Configúralo con `npm run gpu:setup` (descarga las libs de NVIDIA una sola vez). Sin GPU, todo funciona igual en CPU.
- **Modelo cargado al arrancar**: la app precarga y calienta el modelo de embeddings siempre que inicia, así la primera búsqueda es inmediata.
- **Selección de carpetas**: cada carpeta se indexa de forma independiente; un error en una (permisos, disco desconectado) no interrumpe a las demás, y las peticiones que llegan mientras se indexa se encolan.
- **3 modelos de embeddings (ONNX, locales y multilingües)**: la app analiza tu equipo (RAM, VRAM, núcleos) y recomienda uno de los tres:
  | Modelo | Para quién | Descarga | Dim |
  |---|---|---|---|
  | `multilingual-e5-small` | equipos muy limitados (4 GB RAM) | ~50 MB | 384 |
  | `multilingual-e5-base` | equipo normal (8 GB RAM) | ~110 MB | 768 |
  | `bge-m3` | equipos potentes o con GPU | ~550 MB | 1024 |
- **Clientes conectados**: vista «Clientes» con los agentes/apps que consultan el cerebro vía MCP o API (nombre, IP, peticiones, última actividad).
- **Segundo plano**: al cerrar la ventana la app sigue viva en la bandeja del sistema; tus agentes siguen pudiendo consultar. «Salir» desde la bandeja la termina de verdad.
- **Búsqueda híbrida**: vectorial (sqlite-vec, coseno) + palabras clave (FTS5/BM25) fusionada con RRF, con umbral de similitud y peso configurable.
- **Conexión a agentes**:
  - **MCP** (Streamable HTTP) en `/mcp` con herramientas `buscar`, `listar_carpetas`, `leer_documento`, `estado_index`.
  - **API REST** en `/v1` (`buscar`, `carpetas`, `documento`, `estado`, `indexar`, `salud`).
  - **Prompt copiable** para que tu agente se configure solo (pega y listo).
- **Seguridad**: token Bearer, por defecto solo `127.0.0.1`, lectura limitada a carpetas indexadas, sin telemetría.

## 🌐 Modo web (sin Electron)

```bash
npm install
npm run gpu:setup        # (opcional, Linux + GPU NVIDIA) habilita CUDA
npm run build            # build + web entry
npm run start            # arranca el servidor HTTP y abre el navegador
```

- UI en http://127.0.0.1:PUERTO
- API completa: `/v1/*` (con token) + `/mcp` (Streamable HTTP)
- Puente `/bridge`: POST JSON → mismo comportamiento que el IPC de Electron
- EventSource `/events`: SSE con todos los eventos push (log, progreso, folders:changed, stats:changed, server:status, model:download, clients:changed)
- `/events` y `/bridge` **no requieren token** (acceso localhost-only)

## 💿 Modo Electron (clásico)

```bash
npm install
npm run app              # build + electron-rebuild + electron .
```

o empaquetar:

```bash
npm run dist             # → .exe Windows (NSIS), .AppImage + .deb Linux
```

> En Linux, `npm run dist` ejecuta antes `gpu:setup` para que el instalador incluya el runtime CUDA si existe GPU NVIDIA.

## 🛠 Desarrollo

```bash
npm run typecheck        # tipos TypeScript
npm run smoke            # prueba end-to-end: indexa, busca, prueba API y MCP (19 aserciones)
npm run gpu:setup        # habilita embeddings en GPU (solo linux-x64 + GPU NVIDIA)
```

## ⚙️ Arquitectura

```
src/
├── shared/           tipos y catálogos compartidos (main ↔ renderer)
│   ├── types.ts      interfaces (carpetas, modelos, clientes, progreso, eventos…)
│   ├── presets.ts    extensiones y presets de tipos de archivo
│   └── version.ts    versión (lee de package.json)
└── main/
    ├── index.ts      proceso Electron: ventana, bandeja, IPC + HTTP bridge
    ├── web.ts        entrada modo web (servidor HTTP + navegador)
    ├── app.ts        orquestador CerebroApp (arranque, eventos, API interna)
    ├── clients.ts    registro de clientes conectados (MCP/API)
    ├── config.ts     ajustes (config.json en userData/data/cerebro)
    ├── hardware.ts   detección GPU (nvidia-smi)
    ├── logger.ts     registro en vivo con suscripción
    ├── models/       catálogo de modelos + recomendador + motor ONNX (GPU/CPU)
    │   ├── catalog.ts 3 modelos verificados + recomendador por hardware
    │   └── engine.ts   motor de embeddings con device cuda/cpu y fallback
    ├── fs/scan.ts    escáner con gitignore/ocultos/globs/extensiones
    ├── parse/        extracción de texto (utf-8, PDF vía unpdf)
    ├── chunk.ts      fragmentación por párrafo/frase con solape
    ├── db/           SQLite + sqlite-vec + FTS5; búsqueda híbrida (RRF)
    ├── index/        indexador incremental reanudable con progreso
    └── server/       Express: API REST v1 + MCP Streamable HTTP + /bridge + /events
src/preload/          contextBridge (invoke + eventos push)
src/renderer/         interfaz (HTML/CSS/TS, sin framework) conectada por IPC o puente HTTP
scripts/
├── build.mjs         bundling esbuild (main/preload CJS, renderer IIFE)
├── setup-gpu.mjs     descarga e instala el runtime CUDA 13 de NVIDIA (linux-x64)
└── smoke.ts           prueba end-to-end
```

## 🔄 Pipeline

**Escaneo con diff** (por carpeta, con aislamiento de errores) → **Parseo** → **Chunking** (offsets exactos con solape) → **Embeddings ONNX locales** (GPU si está disponible) → `sqlite-vec` (coseno) + FTS5 → **Búsqueda híbrida RRF** → expuesta por **MCP/API** con token.

## 🔧 Cambio de modelo

Si cambia el modelo activo, la tabla vectorial se reconstruye y los archivos pasan a «pendiente de re-vectorización» automáticamente. Se conserva el historial de embeddings antiguos mientras se recomputan.

## 🚀 GPU (Linux + NVIDIA)

```bash
npm run gpu:setup    # descarga cudart/cublas/curand de NVIDIA (~900 MB, una vez)
npm run app          # o npm run dist para empaquetar con GPU incluida
```

El motor prueba CUDA primero y cae a CPU automáticamente si la GPU no está disponible; la barra de estado muestra `· GPU` cuando los embeddings van en la gráfica.

## 🔒 Seguridad y privacidad

- Todo el procesamiento es local. Los únicos tráficos de red son: descarga del modelo (una vez) y peticiones entre tus agentes y `localhost`.
- `GET /v1/documento` y `leer_documento` solo aceptan rutas dentro de carpetas indexadas (403 en caso contrario).
- Sin autenticación no hay acceso (401). El token se regenera desde Ajustes.
- Modo web: los canales `/bridge` y `/events` son localhost-only y no requieren token (diseñados para UI en el mismo equipo).

## 📖 Roadmap (fase 2)

- Watcher en tiempo real (chokidar) además del re-escaneo por intervalo.
- DOCX/ODT/PPTX y OCR de PDFs escaneados.
- Playground con LLM (API key del usuario u Ollama) para RAG conversacional.
- Webhooks de eventos, SDK Python/TypeScript.
- Cifrado del índice en disco y modo estrictamente local opcional.

## 🚀 Primeros pasos

1. `npm install` (una vez)
2. `npm run gpu:setup` (opcional: GPU en Linux + NVIDIA)
3. `npm run typecheck` (verifica que todo compile)
4. `npm start` → abre http://127.0.0.1:7433 (o inicia la app Electron con `npm run app`)
5. La app cargará el modelo recomendado para tu equipo al arrancar
6. Añade una carpeta con el botón "Añadir carpeta"
7. Espera a que termine la indexación (GPU si la tienes, CPU si no)
8. Ve a "Playground" y prueba búsquedas semánticas y híbridas
9. Copia el prompt MCP o configura tu agente vía API REST; en «Clientes» verás cuándo conecta

## 📄 Licencia

[MIT](LICENSE) — úsalo, modifícalo y compártelo libremente.

---

**Cerebro Local** — 100 % local, sin nube, totalmente tuyo.
