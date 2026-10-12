/**
 * Genera una frutinovela de prueba completa con proveedores falsos e informa de
 * las caracteristicas del MP4 resultante. Sirve para inspeccionar el render a
 * ojo y verificar la resolucion, duracion y streams.
 *
 * Uso: node scripts/demo-render.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runDraftPipeline, composeFinal, probeDuration } from '../packages/core/dist/index.js';

const require = createRequire(import.meta.url);
const FFMPEG = require('ffmpeg-static');

const OUT = path.resolve('storage/demo');
mkdirSync(OUT, { recursive: true });

let frameIndex = 0;
const PALETTE = ['crimson', 'indigo', 'darkgreen', 'darkorange', 'purple', 'teal'];

function fakeFrame() {
  const dir = mkdtempSync(path.join(tmpdir(), 'f-img-'));
  const file = path.join(dir, 'f.png');
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `color=c=${PALETTE[frameIndex++ % PALETTE.length]}:s=1080x1920:d=1`,
    '-frames:v', '1', file,
  ], { stdio: 'ignore' });
  return readFileSync(file).toString('base64');
}

function fakeAudio(seconds, freq) {
  const dir = mkdtempSync(path.join(tmpdir(), 'f-aud-'));
  const file = path.join(dir, 'a.mp3');
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
    '-c:a', 'libmp3lame', file,
  ], { stdio: 'ignore' });
  return readFileSync(file).toString('base64');
}

const SCRIPT = JSON.stringify({
  title: 'La Ciruela Secreta',
  premise: 'La fresa descubre que su novio es una ciruela.',
  visualStyleId: 'stopmotion',
  characters: [
    { name: 'Fresa', species: 'fresa', archetype: 'hero', visualDescription: 'roja, brillante', personality: 'ingenuza' },
    { name: 'Ciruela', species: 'ciruela', archetype: 'villain', visualDescription: 'violeta oscura', personality: 'calculadora' },
  ],
  scenes: [
    { role: 'hook', narration: 'CIRUELA: Te menti desde el primer dia.', shotDescription: 'Primer plano de la ciruela', characterIds: ['c2'] },
    { role: 'setup', narration: 'La fresa no podia creer lo que estaba pasando.', shotDescription: 'La fresa sola en la cocina', characterIds: ['c1'] },
    { role: 'conflict', narration: 'Fresa: Quien mas sabia de esto?', shotDescription: 'La fresa grita', characterIds: ['c1', 'c2'] },
    { role: 'escalation', narration: 'Ciruela: Todo el huerto lo sabia menos tu.', shotDescription: 'La ciruela se acerca', characterIds: ['c2'] },
    { role: 'escalation', narration: 'Las verduras empezaron a susurrar en la oscuridad.', shotDescription: 'Many verduras miran', characterIds: [] },
    { role: 'turn', narration: 'Entonces la banana hablo y todo cambio para siempre.', shotDescription: 'La banana entra en escena', characterIds: [] },
    { role: 'cliffhanger', narration: 'Pero lo que dijo la banana... lo cambio todo.', shotDescription: 'La banana mira a camara', characterIds: [] },
  ],
});

const t0 = Date.now();
const storageDir = mkdtempSync(path.join(tmpdir(), 'f-run-'));

const story = await runDraftPipeline(
  {
    llm: { async complete() { return SCRIPT; } },
    image: { async generate() { return { base64: fakeFrame(), mimeType: 'image/png' }; } },
    tts: {
      async speak() { return { base64: fakeAudio(3, 200 + frameIndex * 30), mimeType: 'audio/mpeg' }; },
      stripSpeakerLabels(t, cast) {
        if (!cast.length) return t;
        const re = new RegExp(`(^|\\n)\\s*(?:${cast.join('|')})\\s*:\\s*`, 'gi');
        return t.replace(re, (_m, nl) => `${nl}\n`).replace(/\n{2,}/g, '\n').trim();
      },
    },
    storageDir,
    onProgress: (p) => {
      if (p.status === 'done') console.log(`  [${p.stage}] ${p.completed}/${p.total}`);
    },
  },
  { topic: 'demo', sceneCount: 7 },
);

for (const s of story.scenes) s.status = 'approved';
const mp4 = await composeFinal(
  { llm: null, image: null, tts: null, storageDir },
  story,
  { quality: 'standard', requireApproval: true },
);

const duration = await probeDuration(mp4);

// ffmpeg imprime los metadatos del archivo en stderr y sale con codigo 1
// cuando no hay salida que producir. Eso es normal, no un fallo.
function probeInfo(file) {
  try {
    return execFileSync(FFMPEG, ['-i', file], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (error) {
    return error.stderr ?? '';
  }
}

const info = probeInfo(mp4);

const resolution = info.match(/,\s(\d{2,5})x(\d{2,5})[,\s]/)?.[0]?.trim() ?? '?';
const vCodec = info.match(/Video:\s([a-z0-9]+)/)?.[1] ?? '?';
const aCodec = info.match(/Audio:\s([a-z0-9]+)/)?.[1] ?? '?';

console.log('\n--- Resultado ---');
console.log('Archivo:      ', mp4);
console.log('Tamano:       ', (readFileSync(mp4).length / 1024).toFixed(0), 'KB');
console.log('Duracion:     ', duration.toFixed(2), 's');
console.log('Resolucion:   ', resolution);
console.log('Codec video:  ', vCodec);
console.log('Codec audio:  ', aCodec);
console.log('Planos:       ', story.scenes.length);
console.log('Tiempo total: ', ((Date.now() - t0) / 1000).toFixed(1), 's');
console.log('\nSubtítulos en:', path.join(storageDir, story.id, 'subtitles.ass'));