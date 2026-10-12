/** Prueba real de Edge TTS: genera audio y mide lo que tarda. */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EdgeTtsProvider } from '../packages/core/dist/providers/tts-edge.js';
import { probeDuration } from '../packages/core/dist/render/ffmpeg.js';

const require = createRequire(import.meta.url);
const FFMPEG = require('ffmpeg-static');

const OUT = path.resolve('storage/prueba-voz');
mkdirSync(OUT, { recursive: true });

const FRASES = [
  { voz: 'andrea', texto: 'Te menti todo el tiempo, Ciruela. Y ahora me vas a pagar por eso.' },
  { voz: 'gonzalo', texto: 'Parce, yo te lo dije. Aqui no repartimos ni a pale.' },
  { voz: 'dalia', texto: '¿Y ahora que dice el numero? ¿Dice en revision de que?' },
];

console.log('\n=== Edge TTS ===\n');

for (const f of FRASES) {
  const t = Date.now();
  try {
    const p = new EdgeTtsProvider({ voice: `es-CO-${f.vozo === 'andrea' ? 'Andrea' : f.vozo === 'gonzalo' ? 'Gonzalo' : 'Andrea'}Neural` });
    const audio = await p.speak(f.texto);

    const file = path.join(OUT, `${f.voz}.mp3`);
    writeFileSync(file, Buffer.from(audio.base64, 'base64'));

    const dur = await probeDuration(file);
    const palabras = f.texto.split(/\s+/).length;
    console.log(
      `  ${f.voz.padEnd(9)} OK  ${String(Date.now() - t).padStart(5)}ms  `
      + `${dur.toFixed(2)}s audio  ${palabras} palabras  `
      + `${Math.round(dur / palabras * 1000)}ms/palabra`,
    );
  } catch (e) {
    console.log(`  ${f.voz.padEnd(9)} FALLA  ${e.message.slice(0, 80)}`);
  }
}

console.log('\n  Audio en:', OUT, '\n');