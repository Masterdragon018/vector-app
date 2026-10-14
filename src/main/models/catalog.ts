import os from 'node:os';
import type { HardwareInfo, ModelInfo, ModelRecommendation } from '../../shared/types';
import { detectGpus } from '../hardware';

/*
 * Catálogo de modelos locales (ONNX vía Hugging Face).
 * Todos los repos están verificados contra la API de HF (existentes, con versión cuantizada q8).
 * Orden = calidad creciente. `minRamGB` es orientativo para la indexación cómoda.
 */
export const MODEL_CATALOG: ModelInfo[] = [
  {
    id: 'multilingual-e5-small',
    label: 'multilingual-e5-small',
    repo: 'Xenova/multilingual-e5-small',
    dim: 384,
    ctx: 512,
    paramsM: 47,
    downloadMB: 50,
    minRamGB: 4,
    multilingual: true,
    lang: 'multilingüe (es/en/…)',
    tier: 'ligero',
    prefixes: { query: 'query: ', passage: 'passage: ' },
    desc: 'El más rápido y ligero. Multilingüe: buen español con equipos modestos.'
  },
  {
    id: 'bge-small-en',
    label: 'bge-small-en-v1.5',
    repo: 'Xenova/bge-small-en-v1.5',
    dim: 384,
    ctx: 512,
    paramsM: 33,
    downloadMB: 34,
    minRamGB: 4,
    multilingual: false,
    lang: 'ingés',
    tier: 'ligero',
    desc: 'El más pequeño de todos. Solo si trabajas casi en inglés.'
  },
  {
    id: 'multilingual-e5-base',
    label: 'multilingual-e5-base',
    repo: 'Xenova/multilingual-e5-base',
    dim: 768,
    ctx: 512,
    paramsM: 110,
    downloadMB: 110,
    minRamGB: 8,
    multilingual: true,
    lang: 'multilingüe (es/en/…)',
    tier: 'equilibrado',
    prefixes: { query: 'query: ', passage: 'passage: ' },
    desc: 'Buen equilibrio entre calidad y velocidad en CPU. Multilingüe.'
  },
  {
    id: 'nomic-embed-text',
    label: 'nomic-embed-text-v1',
    repo: 'Xenova/nomic-embed-text-v1',
    dim: 768,
    ctx: 2048,
    paramsM: 137,
    downloadMB: 130,
    minRamGB: 8,
    multilingual: false,
    lang: 'ingés',
    tier: 'equilibrado',
    desc: 'Contexto largo (2048) y buena calidad. Mejor para contenido en inglés.'
  },
  {
    id: 'bge-base-en',
    label: 'bge-base-en-v1.5',
    repo: 'Xenova/bge-base-en-v1.5',
    dim: 768,
    ctx: 512,
    paramsM: 109,
    downloadMB: 110,
    minRamGB: 8,
    multilingual: false,
    lang: 'ingés',
    tier: 'equilibrado',
    desc: 'Referente en inglés a 768 dims. Multilingüe no: para español usa e5 o bge-m3.'
  },
  {
    id: 'multilingual-e5-large',
    label: 'multilingual-e5-large',
    repo: 'Xenova/multilingual-e5-large',
    dim: 1024,
    ctx: 512,
    paramsM: 560,
    downloadMB: 560,
    minRamGB: 16,
    multilingual: true,
    lang: 'multilingüe (es/en/…)',
    tier: 'potente',
    prefixes: { query: 'query: ', passage: 'passage: ' },
    desc: 'Alta calidad multilingüe (1024 dims). Para equipos con RAM de sobra.'
  },
  {
    id: 'bge-large-en',
    label: 'bge-large-en-v1.5',
    repo: 'Xenova/bge-large-en-v1.5',
    dim: 1024,
    ctx: 512,
    paramsM: 335,
    downloadMB: 330,
    minRamGB: 12,
    multilingual: false,
    lang: 'ingés',
    tier: 'potente',
    desc: 'Alta precisión en inglés. En español rinde por debajo de los multilingües.'
  },
  {
    id: 'mxbai-embed-large',
    label: 'mxbai-embed-large',
    repo: 'mixedbread-ai/mxbai-embed-large-v1',
    dim: 1024,
    ctx: 512,
    paramsM: 335,
    downloadMB: 330,
    minRamGB: 12,
    multilingual: false,
    lang: 'ingés',
    tier: 'potente',
    desc: 'Modelo oficial de Mixedbread (1024 dims). Muy bueno en inglés; instrucciones en español, mejor bge-m3.'
  },
  {
    id: 'bge-m3',
    label: 'bge-m3',
    repo: 'Xenova/bge-m3',
    dim: 1024,
    ctx: 8192,
    paramsM: 568,
    downloadMB: 550,
    minRamGB: 16,
    multilingual: true,
    lang: 'multilingüe (es/en/…)',
    tier: 'maximo',
    desc: 'El mejor para español: multilingüe, 1024 dims y contexto largo. Ideal con GPU o equipo potente.'
  }
];

export const getModel = (id: string): ModelInfo | undefined => MODEL_CATALOG.find((m) => m.id === id);

export async function detectHardware(dataDir: string): Promise<HardwareInfo> {
  const cpus = os.cpus();
  const gpus = await detectGpus();
  let diskFreeGB = 0;
  try {
    const { statfsSync } = await import('node:fs');
    const st = statfsSync(dataDir);
    diskFreeGB = Math.round(((st.bavail * st.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    diskFreeGB = 0;
  }
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    osVersion: `${os.type()} ${os.release()}`,
    cpuModel: cpus[0]?.model?.trim() ?? 'desconocido',
    cpuCores: cpus.length,
    cpuSpeedMHz: cpus[0]?.speed ?? 0,
    ramTotalGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    ramFreeGB: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    gpus,
    dataDir,
    diskFreeGB
  };
}

/*
 * Regla de recomendación: a mejor equipo, mejor modelo.
 * Prioridad: GPU con VRAM suficiente > RAM > núcleos de CPU.
 * Todos los modelos son locales (ONNX); el modelo define la dimensión del índice.
 */
export function recommendModel(hw: HardwareInfo): ModelRecommendation {
  const ram = hw.ramTotalGB;
  const cores = hw.cpuCores;
  const vram = hw.gpus.reduce((acc, g) => acc + g.vramMB, 0) / 1024;
  const alternatives = (exclude: string) => MODEL_CATALOG.filter((m) => m.id !== exclude).map((m) => m.id);

  const pick = (id: string, tier: ModelRecommendation['tier'], reason: string): ModelRecommendation => {
    const m = getModel(id)!;
    return { modelId: m.id, model: m, tier, reason, alternatives: alternatives(m.id) };
  };

  if (vram >= 6 && ram >= 14) {
    return pick('bge-m3', 'maximo', `GPU NVIDIA de ${Math.round(vram)} GB y ${ram} GB de RAM: bge-m3 con aceleración por GPU da la máxima calidad.`);
  }
  if (ram >= 30 && cores >= 8) {
    return pick('bge-m3', 'maximo', `Equipo potente (${ram} GB RAM, ${cores} núcleos): bge-m3 ofrece la mejor búsqueda en español.`);
  }
  if (ram >= 22 && cores >= 6) {
    return pick('multilingual-e5-large', 'potente', `${ram} GB de RAM y ${cores} núcleos: multilingual-e5-large aprovecha tu equipo sin GPU.`);
  }
  if (ram >= 14 && cores >= 4) {
    return pick('multilingual-e5-base', 'equilibrado', `${ram} GB de RAM y ${cores} núcleos: multilingual-e5-base da buena calidad sin ralentizar tu equipo.`);
  }
  if (ram >= 7 && cores >= 2) {
    return pick('multilingual-e5-small', 'ligero', `${ram} GB de RAM: multilingual-e5-small mantiene la indexación fluida.`);
  }
  return pick('multilingual-e5-small', 'ligero', `Equipo modesto (${ram} GB RAM, ${cores} núcleos): usamos el modelo más ligero para no saturar la memoria.`);
}
