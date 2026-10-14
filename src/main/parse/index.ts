import { promises as fsp } from 'node:fs';

export type ParsedDoc = { kind: 'text'; text: string } | { kind: 'pages'; pages: string[] };
export type ParseSkip = { skipped: true; reason: string };

const BINARY_EXTS = new Set(['.pdf']);

const SPECIAL_TEXT: Record<string, string> = {
  '.makefile': '',
  '.dockerfile': ''
};

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  let nulls = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) nulls++;
  return nulls > 0;
}

function decodeText(buf: Buffer): string {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/* Parsea un archivo según su tipo. Los binarios no soportados se marcan como skipped. */
export async function parseFile(path: string, ext: string): Promise<ParsedDoc | ParseSkip> {
  if (ext === '.pdf') return parsePdf(path);

  let buf: Buffer;
  try {
    buf = await fsp.readFile(path);
  } catch (e: any) {
    return { skipped: true, reason: `no legible: ${e.message}` };
  }
  if (looksBinary(buf)) return { skipped: true, reason: 'contenido binario' };
  const text = decodeText(buf);
  if (!text.trim()) return { skipped: true, reason: 'archivo vacío' };
  void SPECIAL_TEXT;
  return { kind: 'text', text };
}

/* Extracción de texto de PDF con unpdf (pdf.js), una entrada por página. */
async function parsePdf(path: string): Promise<ParsedDoc | ParseSkip> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const buf = await fsp.readFile(path);
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text, totalPages } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text])
      .map((p) => String(p ?? '').replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 0);
    if (pages.length === 0 || totalPages === 0) return { skipped: true, reason: 'PDF sin texto extraíble (¿escaneado?)' };
    return { kind: 'pages', pages };
  } catch (e: any) {
    return { skipped: true, reason: `PDF ilegible: ${e.message}` };
  }
}
