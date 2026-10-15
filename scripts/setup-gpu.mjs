// Setup GPU (CUDA 13, linux-x64): hace que onnxruntime-node pueda usar la gráfica.
//
// ONNX Runtime trae el provider CUDA (libonnxruntime_providers_cuda.so) pero NO las
// libs runtime de CUDA (cudart, cublas, cublasLt, curand), que NVIDIA solo distribuye
// aparte. Este script:
//   1. las descarga del redistribuible oficial de NVIDIA (una vez, cacheadas en vendor/)
//   2. las copia junto al provider (que ya resuelve $ORIGIN) dentro de node_modules
//   3. añade RPATH '$ORIGIN' al provider con patchelf (sin eso, el dlopen no mira
//      junto al .so y la app empaquetada falla con ENOENT)
//
// Idempotente: si ya está todo puesto, no hace nada. Fuera de linux-x64 se omite.
// La app sigue funcionando en CPU si esto no se ejecuta: el motor prueba CUDA y
// cae a CPU automáticamente si el provider no carga.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

const REDIST_BASE = 'https://developer.download.nvidia.com/compute/cuda/redist/';
const REDIST_META = 'https://developer.download.nvidia.com/compute/cuda/redist/redistrib_13.2.0.json';
const ARTIFACTS = ['cuda_cudart', 'libcublas', 'libcurand'];
const SO_FILES = [
  'libcudart.so.13',
  'libcublas.so.13',
  'libcublasLt.so.13',
  'libcurand.so.10'
];

const log = (m) => console.log(`  [gpu] ${m}`);

if (process.platform !== 'linux' || process.arch !== 'x64') {
  log(`omitido (${process.platform}-${process.arch}): CUDA solo se configura en linux-x64`);
  process.exit(0);
}

const require = createRequire(join(process.cwd(), 'package.json'));

/* ── 0. ¿dónde está el binario de onnxruntime-node? ── */
let ortBin = null;
try {
  ortBin = join(dirname(require.resolve('onnxruntime-node/package.json')), 'bin', 'napi-v6', 'linux', 'x64');
} catch {
  try {
    ortBin = join(dirname(require.resolve('onnxruntime-node')), '..', 'bin', 'napi-v6', 'linux', 'x64');
  } catch {
    log('onnxruntime-node no está instalado · nada que hacer (ejecuta npm install)');
    process.exit(0);
  }
}
if (!existsSync(ortBin)) {
  log(`binario de onnxruntime-node no encontrado en ${ortBin} · omitido`);
  process.exit(0);
}

const provider = join(ortBin, 'libonnxruntime_providers_cuda.so');
const present = SO_FILES.filter((f) => existsSync(join(ortBin, f)));
if (present.length === SO_FILES.length && !needsRpath(provider)) {
  log('CUDA runtime ya instalado · nada que hacer');
  process.exit(0);
}

/* ── 1. conseguir las .so: cache local o descarga ── */
const vendorDir = join(process.cwd(), 'vendor', 'cuda13', 'lib');
mkdirSync(vendorDir, { recursive: true });

if (!SO_FILES.every((f) => existsSync(join(vendorDir, f)))) {
  log(`descargando runtime CUDA 13 desde nvidia.com (~900 MB, solo la primera vez)…`);
  mkdirSync(join(vendorDir, '.tmp'), { recursive: true });
  const meta = await (await fetch(REDIST_META)).json();
  for (const art of ARTIFACTS) {
    const rel = meta[art]?.['linux-x86_64']?.relative_path;
    if (!rel) throw new Error(`artifacto ${art} sin build linux-x86_64 en el redistribuible`);
    const tarPath = join(vendorDir, '.tmp', rel.split('/').pop());
    if (!existsSync(tarPath)) {
      log(`  ${art} ${meta[art].version}…`);
      const res = await fetch(REDIST_BASE + rel);
      if (!res.ok) throw new Error(`descarga fallida (${res.status}): ${REDIST_BASE + rel}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { writeFileSync } = await import('node:fs');
      writeFileSync(tarPath, buf);
    }
    execFileSync('tar', ['-xf', tarPath, '-C', join(vendorDir, '.tmp')], { stdio: 'inherit' });
  }
  // recoger solo las .so que necesitamos (resolviendo symlinks = ficheros reales)
  const seen = new Set();
  for (const entry of readdirSync(join(vendorDir, '.tmp'), { recursive: true })) {
    const p = join(vendorDir, '.tmp', String(entry));
    const name = String(entry).split('/').pop();
    if (!SO_FILES.some((f) => name.startsWith(f))) continue;
    try {
      if (!statSync(p).isFile() || seen.has(name)) continue;
      seen.add(name);
      copyFileSync(p, join(vendorDir, name));
    } catch {
      /* symlink roto o directorio */
    }
  }
  rmSync(join(vendorDir, '.tmp'), { recursive: true, force: true });
  for (const f of SO_FILES) {
    if (!existsSync(join(vendorDir, f))) throw new Error(`no se obtuvo ${f} del redistribuible`);
  }
  log('runtime CUDA descargado y cacheado en vendor/cuda13');
}

/* ── 2. copiar junto al provider (ya resuelve $ORIGIN) ── */
for (const f of SO_FILES) copyFileSync(join(vendorDir, f), join(ortBin, f));
log(`${SO_FILES.length} libs CUDA copiadas en ${ortBin}`);

/* ── 3. RPATH $ORIGIN en el provider (requiere patchelf) ── */
if (existsSync(provider)) {
  if (needsRpath(provider)) {
    let patchelf = null;
    for (const cand of ['patchelf', join(process.env.HOME ?? '', '.local/bin/patchelf')]) {
      try {
        execFileSync(cand, ['--version'], { stdio: 'ignore' });
        patchelf = cand;
        break;
      } catch {
        /* no está ahí */
      }
    }
    if (patchelf) {
      execFileSync(patchelf, ['--set-rpath', '$ORIGIN', provider], { stdio: 'inherit' });
      log("RPATH '$ORIGIN' añadido al provider CUDA");
    } else {
      log('AVISO: patchelf no está disponible (pip install patchelf).');
      log('       Sin RPATH la app de desarrollo usará GPU solo si lanzas con');
      log(`       LD_LIBRARY_PATH=${ortBin}`);
    }
  } else {
    log('RPATH del provider ya configurado');
  }
}

log('setup GPU completo · el motor usará CUDA si hay GPU NVIDIA disponible');

function needsRpath(soPath) {
  try {
    const out = execFileSync('readelf', ['-d', soPath], { encoding: 'utf8' });
    return !/\$ORIGIN/.test(out);
  } catch {
    return false;
  }
}
