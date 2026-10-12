/**
 * Pruebas de la edicion estructural: reordenar, duplicar, borrar y
 * regenerar variantes.
 *
 * Estas operaciones son las que mas se repiten en la interfaz y las que mas
 * способnen dejar la historia en un estado incoherente si fallan: un indice
 * desfasado descoloca los subtitulos, y un id duplicado sobrescribe los
 * archivos del plano original.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  deleteScene,
  duplicateScene,
  regenerateScene,
  reorderScenes,
  parseStoryResponse,
} from '../dist/index.js';

const require = createRequire(import.meta.url);
const FFMPEG = require('ffmpeg-static');

function fakeFrame() {
  const dir = mkdtempSync(path.join(tmpdir(), 'e-img-'));
  const file = path.join(dir, 'f.png');
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'color=c=crimson:s=1080x1920:d=1', '-frames:v', '1', file,
  ], { stdio: 'ignore' });
  return readFileSync(file).toString('base64');
}

const SCRIPT = JSON.stringify({
  title: 'Prueba',
  characters: [{ name: 'Fresa', species: 'fresa', archetype: 'hero', visualDescription: 'roja', personality: 'x' }],
  scenes: [
    { role: 'hook', narration: 'Uno', shotDescription: 'A', characterIds: ['c1'] },
    { role: 'setup', narration: 'Dos', shotDescription: 'B', characterIds: ['c1'] },
    { role: 'conflict', narration: 'Tres', shotDescription: 'C', characterIds: ['c1'] },
    { role: 'turn', narration: 'Cuatro', shotDescription: 'D', characterIds: ['c1'] },
  ],
});

function makeStory() {
  return parseStoryResponse(SCRIPT, 'story-1');
}

function makeDeps(storageDir) {
  let n = 0;
  return {
    get imageCalls() { return n; },
    deps: {
      llm: { async complete() { return SCRIPT; } },
      image: {
        async generate() { n++; return { base64: fakeFrame(), mimeType: 'image/png' }; },
      },
      tts: { async speak() { return { base64: '', mimeType: 'audio/mpeg' }; } },
      storageDir,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

test('parseStoryResponse inicializa variantes, indice de activa e intentos', () => {
  const story = makeStory();
  for (const scene of story.scenes) {
    assert.deepEqual(scene.variants, []);
    assert.equal(scene.activeVariant, 0);
    assert.equal(scene.attempts, 0);
  }
});

test('reorderScenes reordena y reindexa desde 1', () => {
  const story = makeStory();
  const [s1, s2, s3, s4] = story.scenes;

  reorderScenes(story, [s4.id, s3.id, s2.id, s1.id]);

  assert.deepEqual(story.scenes.map((s) => s.id), [s4.id, s3.id, s2.id, s1.id]);
  assert.deepEqual(story.scenes.map((s) => s.index), [1, 2, 3, 4]);
});

test('reorderScenes rechaza una lista incompleta en vez de perder planos', () => {
  const story = makeStory();
  const ids = story.scenes.map((s) => s.id);

  assert.throws(() => reorderScenes(story, ids.slice(0, 2)), /no coincide/);
  // La historia queda intacta tras el rechazo.
  assert.equal(story.scenes.length, 4);
});

test('reorderScenes rechaza una lista con un id desconocido', () => {
  const story = makeStory();
  const ids = story.scenes.map((s) => s.id);
  ids[2] = 's-fantasma';

  // Mismo numero de ids pero uno no existe: la validacion es estricta a
  // proposito. Un reorden parcial descolocaria los subtitulos en silencio.
  assert.throws(() => reorderScenes(story, ids), /no coincide/);
  assert.equal(story.scenes.length, 4);
  assert.deepEqual(story.scenes.map((s) => s.index), [1, 2, 3, 4]);
});

test('reorderScenes detecta ids repetidos', () => {
  const story = makeStory();
  const ids = story.scenes.map((s) => s.id);
  ids[3] = ids[0];

  assert.throws(() => reorderScenes(story, ids), /no coincide/);
  assert.equal(new Set(story.scenes.map((s) => s.id)).size, 4, 'no se duplico ningun plano');
});

test('duplicateScene inserta una copia justo detras y le da id nuevo', () => {
  const story = makeStory();
  const source = story.scenes[0];
  source.variants = ['/tmp/a.png', '/tmp/b.png'];
  source.activeVariant = 1;
  source.status = 'approved';

  duplicateScene(story, source.id);

  assert.equal(story.scenes.length, 5);
  const copy = story.scenes[1];
  assert.notEqual(copy.id, source.id, 'el id debe ser distinto para no sobrescribir archivos');
  assert.equal(copy.index, 2);
  assert.equal(copy.narration, source.narration);
  assert.deepEqual(copy.variants, source.variants);
  assert.equal(copy.activeVariant, 1);
  // La curacion no se hereda: el duplicado hay que revisarlo.
  assert.equal(copy.status, 'generated');
  assert.deepEqual(story.scenes.map((s) => s.index), [1, 2, 3, 4, 5]);
});

test('duplicateScene con un id inexistente falla claro', () => {
  const story = makeStory();
  assert.throws(() => duplicateScene(story, 's-inexistente'), /No existe el plano/);
});

test('deleteScene borra y reindexa', () => {
  const story = makeStory();
  const target = story.scenes[1];

  deleteScene(story, target.id);

  assert.equal(story.scenes.length, 3);
  assert.equal(story.scenes.some((s) => s.id === target.id), false);
  assert.deepEqual(story.scenes.map((s) => s.index), [1, 2, 3]);
});

test('deleteScene no permite quedarse sin planos', () => {
  const story = makeStory();
  // Se borran todos menos el ultimo.
  for (const scene of [...story.scenes].slice(0, -1)) deleteScene(story, scene.id);
  assert.equal(story.scenes.length, 1);

  // El ultimo plano no se puede borrar: la historia se quedaria vacia y no
  // habria nada que renderizar.
  assert.throws(() => deleteScene(story, story.scenes[0].id), /al menos un plano/);
  assert.equal(story.scenes.length, 1, 'tras el rechazo la historia sigue intacta');
});

test('regenerateScene añade variantes y selecciona la mas reciente', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'e-regen-'));
  const { deps } = makeDeps(storageDir);
  const story = makeStory();

  const scene = story.scenes[1];
  await regenerateScene({ ...deps }, story, scene.id, { variants: 3 });

  assert.equal(scene.variants.length, 3);
  assert.equal(scene.activeVariant, 2, 'al regenerar se muestra la candidata recien creada');
  assert.equal(scene.attempts, 3);
  assert.ok(scene.variants.every((p) => existsSync(p)), 'las tres candidatas existen en disco');
  // Los nombres de archivo llevan el numero de intento, sin repetir.
  assert.equal(new Set(scene.variants).size, 3);
});

test('regenerateScene conserva las variantes anteriores al acumular intentos', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'e-regen2-'));
  const { deps } = makeDeps(storageDir);
  const story = makeStory();
  const scene = story.scenes[0];

  await regenerateScene({ ...deps }, story, scene.id, { variants: 1 });
  await regenerateScene({ ...deps }, story, scene.id, { variants: 2 });

  assert.equal(scene.variants.length, 3, 'nada se descarta al regenerar');
  assert.equal(scene.attempts, 3);
  assert.equal(new Set(scene.variants).size, 3, 'las rutas no se repiten');
});

test('regenerateScene revierte la aprobacion del plano', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'e-regen3-'));
  const { deps } = makeDeps(storageDir);
  const story = makeStory();
  const scene = story.scenes[0];
  scene.status = 'approved';

  await regenerateScene({ ...deps }, story, scene.id, { variants: 1 });

  // Si la imagen cambio, la aprobacion previa ya no significa nada.
  assert.equal(scene.status, 'generated');
});

test('regenerateScene con id inexistente falla claro', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'e-regen4-'));
  const { deps } = makeDeps(storageDir);
  const story = makeStory();

  await assert.rejects(
    () => regenerateScene({ ...deps }, story, 's-fantasma', {}),
    /No existe el plano/,
  );
});

test('regenerar no toca los demas planos de la historia', async () => {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'e-regen5-'));
  const { deps } = makeDeps(storageDir);
  const story = makeStory();

  for (const scene of story.scenes) scene.variants = [`/tmp/${scene.id}.png`];
  const before = story.scenes.map((s) => s.variants.join());

  await regenerateScene({ ...deps }, story, story.scenes[2].id, { variants: 1 });

  assert.equal(story.scenes[0].variants.join(), before[0]);
  assert.equal(story.scenes[1].variants.join(), before[1]);
  assert.equal(story.scenes[3].variants.join(), before[3]);
});