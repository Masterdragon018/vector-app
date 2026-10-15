import os from 'node:os';
import type { HardwareInfo, ModelInfo, ModelRecommendation } from '../../shared/types';
import { detectGpus } from '../hardware';

/*
 * Catálogo de modelos locales (ONNX vía Hugging Face), reducido a tres tamaños:
 *   ligero  → equipos muy limitados (cualquier portátil viejo)
 *   normal  → equipo de uso diario
 *   potente → equipos con GPU o mucha RAM
 * Todos multilingües (buen español) y verificados contra la API de HF.
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
    desc: 'Para equipos muy limitados: 4 GB de RAM, 50 MB de descarga. Multilingüe con buen español.'
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
    tier: 'normal',
    prefixes: { query: 'query: ', passage: 'passage: ' },
    desc: 'El equilibrio para un equipo normal: buena calidad en español sin ocupar recursos de más.'
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
    tier: 'potente',
    desc: 'El mejor para español: multilingüe, 1024 dims y contexto largo. Con GPU NVIDIA va ~14× más rápido.'
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

  if (vram >= 5 && ram >= 10) {
    return pick('bge-m3', 'potente', `GPU ${hw.gpus[0]?.name ?? 'NVIDIA'} con ${Math.round(vram)} GB: bge-m3 en la gráfica da la máxima calidad y va muy rápido.`);
  }
  if (ram >= 16 && cores >= 6) {
    return pick('bge-m3', 'potente', `Equipo potente (${ram} GB RAM, ${cores} núcleos): bge-m3 ofrece la mejor búsqueda en español.`);
  }
  if (ram >= 8 && cores >= 2) {
    return pick('multilingual-e5-base', 'normal', `${ram} GB de RAM y ${cores} núcleos: multilingual-e5-base da buena calidad sin ralentizar tu equipo.`);
  }
  return pick('multilingual-e5-small', 'ligero', `Equipo modesto (${ram} GB RAM, ${cores} núcleos): usamos el modelo más ligero para no saturar la memoria.`);
}
