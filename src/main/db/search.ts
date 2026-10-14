import type { SearchHit, SearchResult } from '../../shared/types';
import type { CerebroDb } from './database';

export interface SearchOptions {
  topK: number;
  threshold: number;
  hybrid: number; // 0..100 → peso de la componente semántica (vectorial)
  folderIds?: number[];
  exts?: string[];
}

const RRF_K = 60;

/**
 * Búsqueda híbrida: recuperación vectorial (sqlite-vec, cosine) + palabras clave (FTS5/BM25),
 * fusionada con Reciprocal Rank Fusion. El peso `hybrid` mezcla ambas señales.
 */
export async function hybridSearch(
  db: CerebroDb,
  embedQuery: (text: string) => Promise<Float32Array>,
  query: string,
  opts: SearchOptions
): Promise<SearchResult> {
  const t0 = performance.now();
  const topK = Math.max(1, Math.trunc(opts.topK));
  const wv = Math.min(100, Math.max(0, opts.hybrid)) / 100;
  const wf = 1 - wv;
  const over = Math.max(topK * 6, 60);

  let queryVec: Float32Array | null = null;
  if (wv > 0) queryVec = await embedQuery(query);

  const scores = new Map<number, number>();
  const sims = new Map<number, number>();

  if (queryVec) {
    const vecHits = db.knn(queryVec, over);
    vecHits.forEach((h, rank) => {
      scores.set(h.chunkId, (scores.get(h.chunkId) ?? 0) + wv / (RRF_K + rank + 1));
      sims.set(h.chunkId, 1 - h.distance);
    });
  }

  if (wf > 0) {
    const ftsHits = db.ftsSearch(query, over);
    ftsHits.forEach((h, rank) => {
      scores.set(h.chunkId, (scores.get(h.chunkId) ?? 0) + wf / (RRF_K + rank + 1));
    });
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  // Suficientes candidatos para poder filtrar por carpeta/extensión sin quedarnos cortos
  const candidateIds = ranked.slice(0, Math.max(topK * 4, over)).map(([id]) => id);
  const details = db.chunkDetails(candidateIds);

  const folderFilter = opts.folderIds && opts.folderIds.length > 0 ? new Set(opts.folderIds) : null;
  const extFilter = opts.exts && opts.exts.length > 0 ? new Set(opts.exts.map((e) => e.toLowerCase())) : null;

  const hits: SearchHit[] = [];
  for (const [chunkId] of ranked) {
    const d = details.get(chunkId);
    if (!d) continue;
    if (folderFilter && !folderFilter.has(d.folderId)) continue;

    let sim = sims.get(chunkId) ?? null;
    if (sim === null && queryVec) {
      const vec = db.getEmbedding(chunkId);
      if (vec) {
        let dot = 0;
        for (let i = 0; i < queryVec.length; i++) dot += queryVec[i] * vec[i];
        sim = dot;
        sims.set(chunkId, dot);
      }
    }
    // Umbral de similitud: se aplica a la señal semántica cuando existe
    if (sim !== null && sim < opts.threshold) continue;
    if (extFilter && !extFilter.has(d.ext)) continue;

    hits.push({
      ruta: d.path,
      carpeta: d.root,
      nombre: d.name,
      ext: d.ext,
      score: Math.round((sim ?? 0) * 1000) / 1000,
      chunk: d.idx,
      texto: d.text
    });
    if (hits.length >= topK) break;
  }

  const ms = Math.round(performance.now() - t0);
  db.recordSearchLatency(ms);
  return { query, resultados: hits, ms };
}
