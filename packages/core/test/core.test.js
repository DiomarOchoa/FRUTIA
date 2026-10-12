/**
 * Pruebas de humo del nucleo, sin red ni claves de API.
 *
 * Ejecutar con:  node --test packages/core/test/*.test.js
 * Se prueban las partes puras (secuencia de roles, parseo del LLM, subtitulos),
 * que son donde un fallo silencioso arruinaria un video sin avisar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseStoryResponse, STYLES, resolveStyle, DEFAULT_STYLE_ID } from '../dist/prompts.js';
import { buildAss, estimateWordTimings, tokenize } from '../dist/render/subtitles.js';
import { probeDuration, writeBase64File } from '../dist/render/ffmpeg.js';

test('tokenize parte el texto y descarta espacios', () => {
  assert.deepEqual(tokenize('  Hola   mundo  '), ['Hola', 'mundo']);
  assert.deepEqual(tokenize(''), []);
});

test('estimateWordTimings reparte la duracion sin pasarse', () => {
  const words = estimateWordTimings('La fresa discover que su novio es una ciruela', 4000);
  assert.equal(words.length, 9);
  assert.equal(words[0].startMs, 0);
  const last = words[words.length - 1];
  assert.ok(Math.abs(last.endMs - 4000) < 50, `termino en ${last.endMs}, esperaba ~4000`);
});

test('estimateWordTimings respeta el offset de linea de tiempo', () => {
  const words = estimateWordTimings('una frase corta', 1000, 5000);
  assert.equal(words[0].startMs, 5000);
});

test('estimateWordTimings de un texto largo no produce tiempos negativos', () => {
  const words = estimateWordTimings('palabra '.repeat(200), 3000);
  assert.ok(words.every((w) => w.startMs >= 0 && w.endMs > w.startMs));
});

test('buildAss emite un header valido y un evento por palabra', () => {
  const cues = [{ words: estimateWordTimings('la fresa es roja', 1500) }];
  const ass = buildAss(cues);

  assert.match(ass, /^\[Script Info\]/);
  assert.match(ass, /\[V4\+ Styles\]/);
  assert.match(ass, /\[Events\]/);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /^Style: Pop,Anton,78,/m);

  const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(dialogues.length, cues[0].words.length);
});

test('buildAss escapa llaves y acentos graves de ASS', () => {
  const ass = buildAss([{ words: [{ word: 'a{b}', startMs: 0, endMs: 100, pauseAfter: 0 }] }]);
  assert.ok(ass.includes('a\\{b\\}'), 'las llaves deben quedar escapadas');
});

test('buildAss con lista vacia no rompe', () => {
  const ass = buildAss([{ words: [] }]);
  assert.match(ass, /\[Events\]/);
});

test('resolveStyle cae al estilo por defecto ante un id desconocido', () => {
  assert.equal(resolveStyle('no-existe').id, STYLES[0].id);
  assert.equal(resolveStyle('pixelart').id, 'pixelart');
});

test('parseStoryResponse acepta JSON envuelto en cercas de codigo', () => {
  const raw = 'Aqui tienes tu guion:\n```json\n{"title":"La ciruela","premise":"x",' +
    '"characters":[{"name":"Ana","species":"ciruela","archetype":"villain"}],' +
    '"scenes":[{"role":"hook","narration":"hola","shotDescription":"plano","characterIds":["c1"]}]}\n```';
  const story = parseStoryResponse(raw, 'abc');

  assert.equal(story.id, 'abc');
  assert.equal(story.title, 'La ciruela');
  assert.equal(story.characters.length, 1);
  assert.equal(story.characters[0].id, 'c1');
  assert.equal(story.scenes.length, 1);
  assert.equal(story.scenes[0].role, 'hook');
  // El arco por defecto debe respetar el hook y el cliffhanger.
  assert.equal(story.scenes[0].role, 'hook');
});

test('parseStoryResponse normaliza ids de personaje por posicion', () => {
  const raw = JSON.stringify({
    characters: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    scenes: [],
  });
  const story = parseStoryResponse(raw, 'x');
  assert.deepEqual(story.characters.map((c) => c.id), ['c1', 'c2', 'c3']);
});

test('parseStoryResponse cae al arquetipo hero ante un valor invalido', () => {
  const raw = JSON.stringify({
    characters: [{ name: 'A', archetype: 'jefe-suprema' }],
    scenes: [],
  });
  assert.equal(parseStoryResponse(raw, 'x').characters[0].archetype, 'hero');
});

test('parseStoryResponse sobrevive a prosa antes y despues del JSON', () => {
  const raw = 'Claro! Aqui va:\n{"title":"T","characters":[],"scenes":[]}\nEspero te sirva.';
  assert.equal(parseStoryResponse(raw, 'x').title, 'T');
});

test('parseStoryResponse no se rompe con llaves dentro de cadenas', () => {
  const raw = JSON.stringify({ title: 'Historia {raro}', characters: [], scenes: [] });
  assert.equal(parseStoryResponse(raw, 'x').title, 'Historia {raro}');
});

test('parseStoryResponse lanza con basura sin JSON', () => {
  assert.throws(() => parseStoryResponse('no hay json aqui', 'x'), /no contiene JSON/);
});

test('parseStoryResponse genera el arco completo cuando faltan planos', () => {
  const raw = JSON.stringify({
    characters: [{ name: 'A' }],
    scenes: [
      { narration: 'a' }, { narration: 'b' },
      { narration: 'c' }, { narration: 'd' },
      { narration: 'e' }, { narration: 'f' },
      { narration: 'g' }, { narration: 'h' },
    ],
  });
  const story = parseStoryResponse(raw, 'x');
  assert.equal(story.scenes[0].role, 'hook');
  assert.equal(story.scenes[7].role, 'cliffhanger');
});

test('parseStoryResponse respeta el estilo pedido si el modelo inventa uno', () => {
  const raw = JSON.stringify({ visualStyleId: 'estilo-inexistente', characters: [], scenes: [] });
  assert.equal(parseStoryResponse(raw, 'x', 'pixelart').visualStyleId, 'pixelart');
});

test('parseStoryResponse acepta un estilo valido Proposed por el modelo', () => {
  const raw = JSON.stringify({ visualStyleId: 'claymation', characters: [], scenes: [] });
  const story = parseStoryResponse(raw, 'x', 'pixelart');
  assert.equal(story.visualStyleId, 'claymation');
  assert.match(story.visualStyle, /arcilla/);
});

test('parseStoryResponse cae al estilo por defecto si no hay ninguno', () => {
  // El valor concreto importa: el estilo por defecto es el que hace que las
  // salidas se parezcan al formato viral. Cambiarlo debe romper este test.
  const story = parseStoryResponse(JSON.stringify({ characters: [], scenes: [] }), 'x');
  assert.equal(story.visualStyleId, DEFAULT_STYLE_ID);
  assert.ok(STYLES.some((s) => s.id === DEFAULT_STYLE_ID));
});

test('el estilo por defecto describe un render 3D cinematografico', () => {
  const estilo = STYLES.find((s) => s.id === DEFAULT_STYLE_ID);
  assert.ok(estilo, 'el estilo por defecto debe existir en el catalogo');
  assert.match(estilo.prompt, /3D/i, 'debe pedir render 3D');
  assert.doesNotMatch(estilo.prompt, /plastilina|pixel|papel/i, 'no debe pedir un estilo incompatible');
});

test('probeDuration lee la duracion real de un archivo generado por ffmpeg', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frutia-'));
  const wav = path.join(dir, 'a.wav');

  // Generamos un tono de 1.5s con el binario incluido en ffmpeg-static.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const bin = require('ffmpeg-static');
  execFileSync(bin, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
    '-c:a', 'pcm_s16le', wav,
  ], { stdio: 'ignore' });

  assert.ok(existsSync(wav));
  const dur = await probeDuration(wav);
  assert.ok(Math.abs(dur - 1.5) < 0.15, `duracion ${dur}, esperaba ~1.5`);
});

test('writeBase64File decodifica correctamente', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frutia-'));
  const out = path.join(dir, 'nested', 'img.png');
  const b64 = Buffer.from('contenido de prueba').toString('base64');
  await writeBase64File(b64, out);
  assert.equal(readFileSync(out, 'utf8'), 'contenido de prueba');
});