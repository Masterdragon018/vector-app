import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { GpuInfo } from '../shared/types';

/* Rutas donde puede estar nvidia-smi (la app gráfica a veces no hereda el PATH del terminal). */
const NVIDIA_SMI_PATHS = [
  'nvidia-smi',
  '/usr/bin/nvidia-smi',
  '/usr/local/bin/nvidia-smi',
  '/snap/bin/nvidia-smi'
];

function parseSmiOutput(stdout: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(.*?),\s*(\d+)\s*$/);
    if (m) gpus.push({ name: m[1].trim(), vramMB: parseInt(m[2], 10) });
  }
  return gpus;
}

/* Respaldo cuando nvidia-smi no está en el PATH: el driver NVIDIA cargado deja
   rastro en /proc (versión) y en los dispositivos /dev/nvidia*. Esto detecta la
   presencia de GPU aunque no podamos leer nombre/VRAM por nvidia-smi. */
function nvidiaPresentWithoutSmi(): boolean {
  try {
    if (existsSync('/proc/driver/nvidia/version')) return true;
  } catch {
    /* ignore */
  }
  try {
    if (existsSync('/dev/nvidia0')) return true;
  } catch {
    /* ignore */
  }
  // Windows: nvidia-smi suele estar en System32, pero si no, la existencia del
  // dispositivo CUDA ya la confirmará el propio onnxruntime al intentar usarla.
  return false;
}

/* Detección de GPU vía nvidia-smi (Windows y Linux con drivers NVIDIA), con
   respaldo por /proc para entornos donde el PATH no incluye nvidia-smi. */
export function detectGpus(): Promise<GpuInfo[]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (gpus: GpuInfo[]) => {
      if (!done) {
        done = true;
        resolve(gpus);
      }
    };
    const tryNext = (i: number) => {
      if (i >= NVIDIA_SMI_PATHS.length) {
        // sin nvidia-smi: si el driver está cargado, asumimos una GPU desconocida
        finish(nvidiaPresentWithoutSmi() ? [{ name: 'NVIDIA (driver detectado)', vramMB: 0 }] : []);
        return;
      }
      try {
        execFile(
          NVIDIA_SMI_PATHS[i],
          ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
          { timeout: 3000, windowsHide: true },
          (err, stdout) => {
            if (err || !stdout.trim()) return tryNext(i + 1);
            const gpus = parseSmiOutput(stdout);
            if (gpus.length === 0) return tryNext(i + 1);
            finish(gpus);
          }
        );
      } catch {
        tryNext(i + 1);
      }
    };
    tryNext(0);
    setTimeout(() => finish([]), 5000);
  });
}

/* Lectura de la versión del driver NVIDIA desde /proc (solo informativo). */
export function nvidiaDriverVersion(): string | null {
  try {
    if (!existsSync('/proc/driver/nvidia/version')) return null;
    const txt = readFileSync('/proc/driver/nvidia/version', 'utf8');
    return txt.split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}
