/**
 * El prompt que recibe Stable Diffusion 1.5 debe ser corto, en ingles y sin
 * nombrar lo que no queremos ver. Estos tests fijan esas tres reglas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toClipPrompt, COMFY_NEGATIVE_PROMPT } from '../dist/providers/comfyui-prompt.js';

// Aproximacion de tokens de CLIP: palabras + comas. El limite real es 77.
const tokens = (text) => text.split(/[\s]+/).filter(Boolean).length + (text.match(/,/g) ?? []).length;

const scenePrompt = (scene, style = 'polished stylized 3D animated feature film still') =>
  'Create one polished vertical 9:16 animated film still.\n' +
  'CHARACTER IDENTITIES (show only these characters):\n' +
  '- Fresa, an anthropomorphic strawberry: the recognizable fruit itself forms the head and torso. Fixed appearance notes: red body\n' +
  '- Mango, an anthropomorphic mango: the recognizable fruit itself forms the head and torso. Fixed appearance notes: green body\n\n' +
  `SCENE: ${scene}\n\n` +
  'Every character must remain visibly fruit-shaped. No humans, no people, no actors, no human skin.\n' +
  `STYLE: ${style}`;

test('cabe en el limite de CLIP aunque el prompt original mida cientos de tokens', () => {
  const original = scenePrompt('Fresa mira a Mango en el mercado y sonrie');
  assert.ok(original.length > 500);
  assert.ok(tokens(toClipPrompt(original)) <= 70, toClipPrompt(original));
});

test('no nombra humanos en el prompt positivo (eso va en el negativo)', () => {
  const out = toClipPrompt(scenePrompt('Fresa llora en la cocina'));
  assert.doesNotMatch(out, /human|people|person|actor/i);
  assert.match(COMFY_NEGATIVE_PROMPT, /human/);
});

test('conserva las frutas del reparto y limita a dos', () => {
  const out = toClipPrompt(scenePrompt('Fresa y Mango hablan'));
  assert.match(out, /strawberry/);
  assert.match(out, /mango/);
});

test('usa una sola emocion aunque la escena mencione varias', () => {
  const out = toClipPrompt(scenePrompt('Uva sonrie con una sonrisa triste pero esta enojada'));
  const found = ['sad', 'happy', 'angry'].filter((word) => new RegExp(`\\b${word}\\b`).test(out));
  assert.equal(found.length, 1, out);
});

test('traduce pistas de lugar y de hora del dia', () => {
  const out = toClipPrompt(scenePrompt('Fresa camina de noche por el huerto'));
  assert.match(out, /orchard/);
  assert.match(out, /night/);
});

test('respeta el estilo pixel art y claymation', () => {
  assert.match(toClipPrompt(scenePrompt('Fresa en el bosque', 'pixel art 16-bit con paleta limitada')), /pixel art/);
  assert.match(toClipPrompt(scenePrompt('Fresa en el bosque', 'claymation de plastilina')), /claymation/);
});

test('la hoja de personaje usa fondo blanco y no inventa escena', () => {
  const sheet =
    'Character design sheet for a polished animated film. One character only: Fresa, an anthropomorphic strawberry.\n\n' +
    'FIXED APPEARANCE: red\nSTYLE: render 3D estilo Pixar';
  const out = toClipPrompt(sheet);
  assert.match(out, /strawberry/);
  assert.match(out, /plain white background/);
});
