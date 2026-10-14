import { execFile } from 'node:child_process';
import type { GpuInfo } from '../shared/types';

/* Detección de GPU vía nvidia-smi (Windows y Linux con drivers NVIDIA). */
export function detectGpus(): Promise<GpuInfo[]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (gpus: GpuInfo[]) => {
      if (!done) {
        done = true;
        resolve(gpus);
      }
    };
    try {
      execFile(
        'nvidia-smi',
        ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
        { timeout: 3000, windowsHide: true },
        (err, stdout) => {
          if (err) return finish([]);
          const gpus: GpuInfo[] = [];
          for (const line of stdout.split('\n')) {
            const m = line.match(/^(.*?),\s*(\d+)\s*$/);
            if (m) gpus.push({ name: m[1].trim(), vramMB: parseInt(m[2], 10) });
          }
          finish(gpus);
        }
      );
    } catch {
      finish([]);
    }
    setTimeout(() => finish([]), 4000);
  });
}
