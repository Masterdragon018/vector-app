export interface ChunkSpec {
  size: number; // tokens objetivo
  overlap: number; // tokens de solape
  min: number; // tokens mínimos por fragmento
}

export interface TextChunk {
  text: string;
  start: number;
  end: number;
}

/* Aproximación práctica tokens→caracteres (inglés ~4, español ~4.5; usamos 4). */
const CHARS_PER_TOKEN = 4;

const BOUNDARIES = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' ', ''];

/**
 * Fragmenta texto en trozos del tamaño indicado respetando fronteras de
 * párrafo/frase y un solape entre fragmentos contiguos. Devuelve offsets
 * exactos sobre el texto original (el contenido se conserva verbatim).
 */
export function chunkText(text: string, spec: ChunkSpec): TextChunk[] {
  const target = Math.max(64, Math.round(spec.size * CHARS_PER_TOKEN));
  const overlap = Math.max(0, Math.round(spec.overlap * CHARS_PER_TOKEN));
  const minLen = Math.max(8, Math.round(spec.min * CHARS_PER_TOKEN));
  const out: TextChunk[] = [];
  if (!text.trim()) return out;

  let pos = 0;
  let guard = 0;
  while (pos < text.length && guard++ < 100000) {
    let end = Math.min(pos + target, text.length);

    if (end < text.length) {
      // busca la última frontera natural en la mitad final de la ventana
      const windowFrom = Math.max(pos + Math.floor(target * 0.5), end - Math.max(400, Math.floor(target * 0.3)));
      let cut = -1;
      for (const b of BOUNDARIES) {
        const idx = text.lastIndexOf(b, end);
        if (idx > windowFrom && idx > pos) {
          cut = idx + b.length;
          break;
        }
      }
      if (cut > pos) end = cut;
    }

    // ajusta inicio/fin a bordes de palabra
    let start = pos;
    while (start < end && /\s/.test(text[start])) start++;
    let stop = end;
    while (stop > start && /\s/.test(text[stop - 1])) stop--;

    const seg = text.slice(start, stop);
    const isLast = end >= text.length;
    if (seg.length >= minLen || (isLast && seg.length > 0 && out.length === 0)) {
      out.push({ text: seg, start, end: stop });
    } else if (isLast && seg.length > 0 && out.length > 0 && seg.length >= Math.floor(minLen / 2)) {
      out.push({ text: seg, start, end: stop });
    }

    if (end >= text.length) break;
    let next = Math.max(end - overlap, pos + 1);
    if (text[next] && !/\s/.test(text[next]) && next > 0 && /\S/.test(text[next - 1])) {
      // salta al siguiente límite de palabra
      while (next < text.length && !/[\s\n]/.test(text[next])) next++;
    }
    pos = next;
  }

  return out;
}

/* Fragmenta cada página de un PDF por separado (mejor localidad por página). */
export function chunkPages(pages: string[], spec: ChunkSpec): TextChunk[] {
  const out: TextChunk[] = [];
  let offset = 0;
  for (const page of pages) {
    const parts = chunkText(page, spec);
    for (const p of parts) out.push({ text: p.text, start: offset + p.start, end: offset + p.end });
    offset += page.length + 2;
  }
  return out;
}
