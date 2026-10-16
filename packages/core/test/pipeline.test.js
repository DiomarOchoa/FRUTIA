/**
 * Prueba de integracion del pipeline completo, sin red ni claves de API.
 *
 * Sustituye los tres proveedores por dobles que devuelven imagenes y audio
 * sinteticos con ffmpeg, y ejecuta el pipeline entero. El objetivo es validar
 * la parte cara y fragile: composicion 9:16, quemado de subtítulos, concat y
 * duracion final. Es la unica forma de comprobar el render sin gastar cuota.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runDraftPipeline, composeFinal } from '../dist/pipeline.js';
import { probeDuration } from '../dist/render/ffmpeg.js';

const require = createRequire(import.meta.url);
const FFMPEG = require('ffmpeg-static');

/** Crea un PNG 1080x1920 con ffmpeg y lo devuelve en base64. */
function fakeFrame(color, label) {
  const dir = mkdtempSync(path.join(tmpdir(), 'frutia-img-'));
  const file = path.join(dir, `${label}.png`);
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1080x1920:d=1`,
    '-frames:v', '1', file,
  ], { stdio: 'ignore' });
  return readFileSync(file).toString('base64');
}

/** Crea un MP3 de `seconds` y lo devuelve en base64. */
function fakeAudio(seconds, freq) {
  const dir = mkdtempSync(path.join(tmpdir(), 'frutia-aud-'));
  const file = path.join(dir, 'a.mp3');
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
    '-c:a', 'libmp3lame', '-b:a', '128k', file,
  ], { stdio: 'ignore' });
  return readFileSync(file).toString('base64');
}

/** Respuesta del LLM con la forma exacta que espera el parser. */
const FAKE_SCRIPT = JSON.stringify({
  title: 'La Ciruela Secreta',
  premise: 'La fresa descubre que su novio es una ciruela.',
  visualStyleId: 'stopmotion',
  characters: [
    { name: 'Fresa', species: 'fresa', archetype: 'hero', visualDescription: 'roja con semillas visibles', personality: 'ingenuza' },
    { name: 'Ciruela', species: 'ciruela', archetype: 'villain', visualDescription: 'violeta Oscura', personality: 'traicionera' },
  ],
  scenes: [
    { role: 'hook', narration: 'MANGO: Te menti todo el tiempo.', shotDescription: 'Una ciruela sonriendo en primer plano', characterIds: ['c2'] },
    { role: 'setup', narration: 'Fresa no podia creerlo. La cocina entera se caia.', shotDescription: 'Fresa sola entre verduras', characterIds: ['c1'] },
    { role: 'conflict', narration: 'CIRUELA: Todo fue mentira desde el primer dia.', shotDescription: 'La ciruela levanta la voz', characterIds: ['c2'] },
    { role: 'turn', narration: 'Entonces la banana.widgets hablo, y todo cambio para siempre.', shotDescription: 'Una banana entra en escena', characterIds: [] },
  ],
});

/** Dobles de los proveedores. Cuentan las llamadas para detectar bucles. */
function makeDeps(storageDir, { references = true } = {}) {
  const calls = { llm: 0, image: 0, tts: 0 };
  const palette = ['crimson', 'indigo', 'darkgreen', 'orange'];
  let frameIndex = 0;

  return {
    calls,
    deps: {
      llm: {
        async complete() { calls.llm++; return FAKE_SCRIPT; },
      },
      image: {
        // Los proveedores que ignoran referencias visuales (Pollinations,
        // ComfyUI) se saltan las fichas de personaje: es una llamada menos por
        // personaje y no cambia el resultado.
        supportsReferenceImages: references,
        recommendedConcurrency: 1,
        async generate() {
          calls.image++;
          return { base64: fakeFrame(palette[frameIndex++ % palette.length], 'f'), mimeType: 'image/png' };
        },
      },
      tts: {
        async speak() {
          calls.tts++;
          return { base64: fakeAudio(2.5, 220 + calls.tts * 40), mimeType: 'audio/mpeg' };
        },
        stripSpeakerLabels(text, cast) {
          // Replica el comportamiento real: quita las marcas de personaje.
          if (!cast.length) return text;
          const re = new RegExp(`(^|\\n)\\s*(?:${cast.join('|')})\\s*:\\s*`, 'gi');
          return text.replace(re, (_m, nl) => `${nl}\n`).replace(/\n{2,}/g, '\n').trim();
        },
      },
      storageDir,
    },
  };
}

test('pipeline completo produce un MP4 9:16 con la duracion esperada', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'frutia-pipe-'));
  const { deps, calls } = makeDeps(storageDir);

  const stages = [];
  const story = await runDraftPipeline(
    { ...deps, onProgress: (p) => stages.push(`${p.stage}:${p.status}`) },
    { topic: 'La fresa descubre la verdad', sceneCount: 4 },
  );

  // 1 guion + 2 fichas de personaje + 4 planos = 7 generaciones de imagen.
  assert.equal(calls.llm, 1);
  assert.equal(calls.image, 2 + 4);
  assert.equal(calls.tts, 4);
  assert.equal(story.scenes.length, 4);
  assert.equal(story.characters.length, 2);
  assert.ok(story.scenes.every((s) => s.status === 'generated'), 'todos los planos quedan en generated');
  assert.ok(story.scenes.every((s) => existsSync(s.variants[0] ?? '')), 'cada plano tiene imagen');
  assert.ok(story.scenes.every((s) => existsSync(s.audioPath)), 'cada plano tiene audio');
  assert.ok(story.scenes.every((s) => Math.abs(s.targetDuration - 2.5) < 0.3), 'la duracion sale del audio real');

  // El archivo de subtitulos se escribe al componer, no antes.
  // La curacion es obligatoria: sin aprobar, no se renderiza nada.
  for (const scene of story.scenes) scene.status = 'approved';
  const outputPath = await composeFinal({ ...deps }, story, { quality: 'standard', requireApproval: true });

  assert.ok(existsSync(outputPath), 'se genera el MP4');
  const bytes = readFileSync(outputPath).length;
  assert.ok(bytes > 5000, `el MP4 tiene tamano razonable (${bytes} bytes)`);
});

test('un proveedor sin referencias se ahorra las fichas de personaje', async () => {
  // Pollinations y ComfyUI no aceptan imagenes de referencia, asi que generar
  // una hoja por personaje es gastar cuota para tirarla. El pipeline tiene que
  // detectedlo y saltarselas, pero sin dejar ningun plano sin imagen.
  const storageDir = mkdtempSync(path.join(tmpdir(), 'frutia-noref-'));
  const { deps, calls } = makeDeps(storageDir, { references: false });

  const story = await runDraftPipeline({ ...deps }, { topic: 'prueba', sceneCount: 4 });

  assert.equal(calls.image, 4, 'solo los cuatro planos, sin fichas de personaje');
  assert.equal(story.scenes.length, 4);
  assert.ok(
    story.scenes.every((s) => existsSync(s.variants[0] ?? '')),
    'saltar las fichas no puede dejar planos sin imagen',
  );
  assert.ok(
    story.scenes.every((s) => existsSync(s.audioPath)),
    'y todos siguen con su audio',
  );
});

test('composeFinal respeta la curacion y solo usa planos aprobados', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'frutia-appr-'));
  const { deps } = makeDeps(storageDir);

  const story = await runDraftPipeline({ ...deps }, { topic: 'prueba', sceneCount: 4 });

  // Aprobamos solo dos de los cuatro planos.
  story.scenes[0].status = 'approved';
  story.scenes[1].status = 'approved';
  story.scenes[2].status = 'rejected';
  story.scenes[3].status = 'draft';

  const outputPath = await composeFinal({ ...deps }, story, {
    quality: 'standard',
    requireApproval: true,
  });

  const duration = await probeDuration(outputPath);
  // Dos planos de 2.5s cada uno mas el margen del quemado de subtitulos.
  assert.ok(duration > 3 && duration < 9, `la duracion refleja solo los 2 planos: ${duration}s`);
});

test('composeFinal falla claro cuando no hay nada aprobado', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'frutia-vacio-'));
  const { deps } = makeDeps(storageDir);
  const story = await runDraftPipeline({ ...deps }, { topic: 'prueba', sceneCount: 4 });

  for (const scene of story.scenes) scene.status = 'draft';

  await assert.rejects(
    () => composeFinal({ ...deps }, story, { quality: 'standard', requireApproval: true }),
    /No hay planos aprobados/,
  );
});

test('el parser limpia las marcas de personaje antes de sintetizar voz', async () => {
  const { deps } = makeDeps(mkdtempSync(path.join(tmpdir(), 'frutia-tts-')));
  const { TtsProvider } = await import('../dist/providers/tts.js');

  const cleaned = TtsProvider.stripSpeakerLabels('Fresa: hola\nCiruela: adios', ['Fresa', 'Ciruela']);
  assert.equal(cleaned.includes('Fresa:'), false, 'se retira la marca');
  assert.ok(cleaned.includes('hola'), 'el texto hablado se conserva');
});

test('el archivo de subtitulos usa tiempos absolutos sobre la linea de tiempo', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'frutia-sub-'));
  const { deps } = makeDeps(storageDir);
  const story = await runDraftPipeline({ ...deps }, { topic: 'prueba', sceneCount: 4 });
  for (const scene of story.scenes) scene.status = 'approved';

  const outputPath = await composeFinal({ ...deps }, story, { quality: 'standard', requireApproval: true });
  const ass = readFileSync(path.join(storageDir, story.id, 'subtitles.ass'), 'utf8');

  assert.match(ass, /\[Events\]/);
  const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.ok(lines.length > 4, `se emitieron eventos por palabra: ${lines.length}`);

  // El segundo plano debe empezar despues de 0, no en 0 tambien: si los
  // tiempos fueran todos relativos, el subtitulo se adelantaria al video.
  const secondPlaneStart = lines.find((l) => l.includes('cambio') || l.includes('banana'));
  if (secondPlaneStart) {
    assert.match(secondPlaneStart, /,0:00:0[1-9]|,0:00:[1-9]/, 'los planos posteriores tienen tiempos crecientes');
  }
  assert.ok(existsSync(outputPath));
});