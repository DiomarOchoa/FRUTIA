/**
 * El render no puede reportarse como correcto con un archivo vacio.
 *
 * Se documento un caso real: el servidor se reinicio mientras ffmpeg escribia,
 * el proceso termino con codigo 0 y dejo un MP4 de 0 bytes. El trabajo se
 * marcaba como "done" y el usuario descargaba un archivo roto sin enterarse.
 * Estos tests fijan que eso ya no pueda pasar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runDraftPipeline, composeFinal, parseStoryResponse } from '../dist/index.js';

const require = createRequire(import.meta.url);
const FFMPEG = require('ffmpeg-static');

function fakeFrame(color) {
  const dir = mkdtempSync(path.join(tmpdir(), 'r-img-'));
  const file = path.join(dir, 'f.png');
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1080x1920:d=1`, '-frames:v', '1', file,
  ], { stdio: 'ignore' });
  return readFileSync(file).toString('base64');
}

function fakeAudio(seconds, freq) {
  const dir = mkdtempSync(path.join(tmpdir(), 'r-aud-'));
  const file = path.join(dir, 'a.wav');
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
    '-c:a', 'pcm_s16le', file,
  ], { stdio: 'ignore' });
  return readFileSync(file).toString('base64');
}

const SCRIPT = JSON.stringify({
  title: 'Prueba de render',
  characters: [{ name: 'Fresa', species: 'fresa', archetype: 'hero', visualDescription: 'roja', personality: 'x' }],
  scenes: [
    { role: 'hook', narration: 'Uno', shotDescription: 'A', characterIds: ['c1'] },
    { role: 'setup', narration: 'Dos', shotDescription: 'B', characterIds: ['c1'] },
  ],
});

function depsFor(storageDir) {
  const colors = ['crimson', 'indigo'];
  let i = 0;
  return {
    llm: { async complete() { return SCRIPT; } },
    image: { async generate() { return { base64: fakeFrame(colors[i++ % 2]), mimeType: 'image/png' }; } },
    tts: {
      async speak() { return { base64: fakeAudio(2, 300), mimeType: 'audio/wav', extension: 'wav' }; },
      stripSpeakerLabels(t) { return t; },
    },
    storageDir,
  };
}

test('el render produce un archivo con contenido real', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'r-ok-'));
  const story = await runDraftPipeline(depsFor(storageDir), { topic: 'prueba', sceneCount: 2 });
  for (const s of story.scenes) s.status = 'approved';

  const out = await composeFinal({ ...depsFor(storageDir) }, story, {
    quality: 'standard', requireApproval: true,
  });

  assert.ok(existsSync(out));
  assert.ok(statSync(out).size > 10_000, `el archivo debe tener contenido (${statSync(out).size} bytes)`);
});

test('un archivo vacio previo se reemplaza, no se reporta como resultado', async () => {
  // Este es el escenario real: un render anterior dejo el MP4 a medias y el
  // siguiente debe sobrescribirlo con contenido completo.
  const storageDir = mkdtempSync(path.join(tmpdir(), 'r-prev-'));
  const story = await runDraftPipeline(depsFor(storageDir), { topic: 'prueba', sceneCount: 2 });
  for (const s of story.scenes) s.status = 'approved';

  const out = path.join(storageDir, story.id, `${story.id}.mp4`);
  writeFileSync(out, '');

  await composeFinal({ ...depsFor(storageDir) }, story, {
    quality: 'standard', requireApproval: true,
  });

  assert.ok(
    statSync(out).size > 10_000,
    'un render nuevo debe reemplazar el archivo vacio, no dejarlo como resultado',
  );
});

test('el progreso informa tamano y duracion, no solo la ruta', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'r-prog-'));
  const story = await runDraftPipeline(depsFor(storageDir), { topic: 'prueba', sceneCount: 2 });
  for (const s of story.scenes) s.status = 'approved';

  const stages = [];
  await composeFinal(
    { ...depsFor(storageDir), onProgress: (p) => stages.push(p) },
    story,
    { quality: 'standard', requireApproval: true },
  );

  const exportStage = stages.find((s) => s.stage === 'export');
  assert.ok(exportStage, 'debe informar la etapa de exportacion');
  assert.match(String(exportStage.message), /\d+s/, 'el mensaje debe incluir la duracion');
  assert.match(String(exportStage.message), /MB/, 'el mensaje debe incluir el tamano');
});

test('renderizar dos veces produce el mismo resultado', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'r-dos-'));
  const story = await runDraftPipeline(depsFor(storageDir), { topic: 'prueba', sceneCount: 2 });
  for (const s of story.scenes) s.status = 'approved';

  const config = { quality: 'standard', requireApproval: true };
  const a = await composeFinal({ ...depsFor(storageDir) }, story, config);
  const sizeA = statSync(a).size;
  const b = await composeFinal({ ...depsFor(storageDir) }, story, config);
  const sizeB = statSync(b).size;

  assert.ok(sizeA > 0 && sizeB > 0);
  assert.ok(Math.abs(sizeA - sizeB) / sizeA < 0.2, 'dos renders del mismo contenido deben ser similares');
});