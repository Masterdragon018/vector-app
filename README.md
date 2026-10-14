# 🧠 Cerebro Local

**Vectoriza tus carpetas y conéctalas a tus agentes mediante MCP o API — 100 % local.**

Cerebro Local es una aplicación de escritorio (Windows y Linux) que convierte las carpetas que tú elijas en un cerebro de conocimiento vectorial. Tus agentes de IA (Claude Desktop, Claude Code, Cursor, Windsurf, cualquier cliente MCP o vía API REST) pueden consultar ese conocimiento con rutas exactas y citas verificables — sin que nada salga de tu equipo.

## ✅ Estado actual (versión 0.2.0)

- **Modo web + Electron**: `npm start` arranca la UI en el navegador (http://127.0.0.1:PUERTO) **o** abre la app Electron clásica. El backend es el mismo: Node + SQLite + sqlite-vec + ONNX.
- **Selección de carpetas**: eliges qué raíces indexar; re-escaneo incremental automático (mtime + tamaño). Ahora se añade carpeta con validación (ruta existe, es carpeta y no duplicada) y feedback visible.
- **Filtros de tipo de archivo**: presets (texto, web, código, documentos, datos) + extensiones concretas, `.gitignore`, carpetas ocultas, `node_modules`, patrones glob y tamaño máximo.
- **Modelos de embeddings locales (ONNX)**: catálogo **verificado** (`multilingual-e5-small`, `multilingual-e5-base`, `nomic-embed-text-v1`, `bge-m3`, `bge-base-en`). La app analiza tu equipo (RAM, VRAM, núcleos) y recomienda el modelo en la UI. **Ya no hay modelos rotos** (mxbai-embed-large fue removido de HF, sustituido por alternativas seguras).
- **Búsqueda híbrida**: vectorial (sqlite-vec, coseno) + palabras clave (FTS5/BM25) fusionada con RRF, con umbral de similitud y peso configurable.
- **Conexión a agentes**:
  - **MCP** (Streamable HTTP) en `/mcp` con herramientas `buscar`, `listar_carpetas`, `leer_documento`, `estado_index`.
  - **API REST** en `/v1` (`buscar`, `carpetas`, `documento`, `estado`, `indexar`).
  - **Prompt copiable** para que tu agente se configure solo (pega y listo).
- **Seguridad**: token Bearer, por defecto solo `127.0.0.1`, lectura limitada a carpetas indexadas, sin telemetría.

## 🌐 Modo web (sin Electron)

```bash
npm install
npm run build            # build + web entry
npm run start            # arranca el servidor HTTP y abre el navegador
```

- UI en http://127.0.0.1:PUERTO
- API completa: `/v1/*` (con token) + `/mcp` (Streamable HTTP)
- Puente `/bridge`: POST JSON → mismo comportamiento que el IPC de Electron
- EventSource `/events`: SSE con todos los eventos push (log, progreso, folders:changed, stats:changed, server:status, model:download)
- `/events` y `/bridge` **no requieren token** (acceso localhost-only)

## 💿 Modo Electron (clásico)

```bash
npm install
npm start                # build + electron-rebuild + electron .
```

o empaquetar:

```bash
npm run dist             # → .exe Windows (NSIS), .AppImage + .deb Linux
```

## 🛠 Desarrollo

```bash
npm run typecheck        # tipos TypeScript
npm run smoke            # prueba end-to-end: indexa, busca, prueba API y MCP (19 aserciones)
npm run doctor           # diagnóstico de instalaciones
```

## ⚙️ Arquitectura

```
src/
├── shared/           tipos y catálogos compartidos (main ↔ renderer)
│   ├── types.ts      interfaces (carpetas, modelos, progreso, eventos…)
│   └── presets.ts    extensiones y presets de tipos de archivo
└── main/
    ├── index.ts      proceso Electron: ventana, IPC + HTTP bridge
    ├── app.ts        orquestador CerebroApp (arranque, eventos, API interna)
    ├── config.ts     ajustes (config.json en userData/data/cerebro)
    ├── hardware.ts   detección GPU (nvidia-smi / onnxruntime)
    ├── logger.ts     registro en vivo con suscripción
    ├── models/       catálogo de modelos + recomendador + motor ONNX
    │   └── catalog.ts catálogo verificado + tipos ModelInfo/Recommendation
    ├── fs/scan.ts    escáner con gitignore/ocultos/globs/extensiones
    ├── parse/        extracción de texto (utf-8, PDF vía unpdf)
    ├── chunk.ts      fragmentación por párrafo/frase con solape
    ├── db/           SQLite + sqlite-vec + FTS5; búsqueda híbrida (RRF)
    ├── index/        indexador incremental reanudable con progreso
    └── server/       Express: API REST v1 + MCP Streamable HTTP + /bridge + /events
src/preload/          contextBridge (invoke + eventos push)
src/renderer/          interfaz (HTML/CSS/TS, sin framework) conectada por IPC o puente HTTP
```

## 🔄 Pipeline

**Escaneo con diff** → **Parseo** → **Chunking** (offsets exactos con solape) → **Embeddings ONNX locales** → `sqlite-vec` (coseno) + FTS5 → **Búsqueda híbrida RRF** → expuesta por **MCP/API** con token.

## 🔧 Cambio de modelo

Si cambia el modelo activo, la tabla vectorial se reconstruye y los archivos pasan a «pendiente de re-vectorización» automáticamente. Se conserva el historial de embeddings antiguos mientras se recomputan.

## 🔒 Seguridad y privacidad

- Todo el procesamiento es local. Los únicos tráficos de red son: descarga del modelo (una vez) y peticiones entre tus agentes y `localhost`.
- `GET /v1/documento` y `leer_documento` solo aceptan rutas dentro de carpetas indexadas (403 en caso contrario).
- Sin autenticación no hay acceso (401). El token se regenera desde Ajustes.
- Modo web: los canales `/bridge` y `/events` son localhost-only y no requieren token (diseñados para UI en el mismo equipo).

## 📦 Instaladores generados (en `release/`)

| Archivo | Tamaño | Uso |
|---|---|---|
| `cerebro-local_0.1.0_amd64.deb` | 353 MB | Instalación en Debian/Ubuntu (`apt install ./release/...`) |
| `Cerebro Local-0.1.0.AppImage` | 439 MB | Portable, sin instalar (chmod +x y ejecutar) |

## 📖 Roadmap (fase 2)

- Watcher en tiempo real (chokidar) además del re-escaneo por intervalo.
- DOCX/ODT/PPTX y OCR de PDFs escaneados.
- Playground con LLM (API key del usuario u Ollama) para RAG conversacional.
- Webhooks de eventos, SDK Python/TypeScript.
- Cifrado del índice en disco y modo estrictamente local opcional.

## 🚀 Primeros pasos

1. `npm install` (una vez)
2. `npm run typecheck` (verifica que todo compile)
3. `npm start` → abre http://127.0.0.1:7433 (o inicia la app Electron)
4. La UI detectará tu hardware y te recomendará un modelo (bge-m3 si tienes GPU)
5. Añade una carpeta con el botón "Añadir carpeta" (o escribe la ruta manualmente en modo web)
6. Espera a que termine la indexación
7. Ve a la vista "Playground" y prueba búsquedas semánticas y híbridas
8. Copia el prompt MCP o configura tu agente vía API REST

---

**Cerebro Local** — 100 % local, sin nube, totalmente tuyo.# vector-app
