// Build: bundle scripts with esbuild, copy static files, MediaPipe WASM and models, zip.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OUT = 'dist';
const MODELS = {
  'hand_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
  'selfie_multiclass_256x256.tflite': 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
  'selfie_segmenter_landscape.tflite': 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite',
};

mkdirSync('assets/models', { recursive: true });
for (const [f, url] of Object.entries(MODELS)) {
  if (existsSync(`assets/models/${f}`)) continue;
  console.log('downloading', f);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`model download failed ${url}: ${r.status}`);
  writeFileSync(`assets/models/${f}`, Buffer.from(await r.arrayBuffer()));
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const common = { bundle: true, minify: !process.argv.includes('--dev'), sourcemap: false, target: 'chrome116', logLevel: 'info' };
await build({ ...common, entryPoints: { hook: 'src/hook.js' }, outdir: OUT, format: 'iife' });
await build({ ...common, entryPoints: { bridge: 'src/bridge.js' }, outdir: OUT, format: 'iife' });
await build({ ...common, entryPoints: { background: 'src/background.js', engine: 'src/engine/engine.js', 'popup/popup': 'src/popup/popup.js', 'preview/preview': 'src/preview/preview.js' }, outdir: OUT, format: 'esm' });

cpSync('src/manifest.json', `${OUT}/manifest.json`);
cpSync('src/engine/engine.html', `${OUT}/engine.html`);
cpSync('src/popup/popup.html', `${OUT}/popup/popup.html`);
cpSync('src/popup/popup.css', `${OUT}/popup/popup.css`);
cpSync('src/preview/preview.html', `${OUT}/preview/preview.html`);
execSync(`node scripts/icons.mjs ${OUT}/icons`, { stdio: 'inherit' });
mkdirSync(`${OUT}/wasm`, { recursive: true });
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) cpSync(`node_modules/@mediapipe/tasks-vision/wasm/${f}`, `${OUT}/wasm/${f}`);
cpSync('assets/models', `${OUT}/models`, { recursive: true, filter: (p) => !p.endsWith('selfie_segmenter.tflite') });

if (!process.argv.includes('--no-zip')) {
  rmSync('vanish-fx.zip', { force: true });
  execSync(`cd ${OUT} && zip -qr ../vanish-fx.zip .`);
  console.log('zip -> vanish-fx.zip');
}
