/**
 * El umbral de 60 segundos.
 *
 * Es una regla externa (TikTok no paga videos cortos) pero el calculo es
 * nuestro, y equivocarse aqui significa producir videos que no valen nada sin
 * que nada falle visiblemente.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStoryResponse } from '../dist/prompts.js';
import {
  totalDuration,
  secondsToMonetizable,
  MIN_MONETIZABLE_SEC,
} from '../dist/pipeline.js';

const SCRIPT = JSON.stringify({
  title: 'Prueba',
  characters: [{ name: 'Fresa', species: 'fresa', archetype: 'hero', visualDescription: 'roja', personality: 'x' }],
  scenes: Array.from({ length: 8 }, (_, i) => ({
    role: i === 0 ? 'hook' : i === 7 ? 'cliffhanger' : 'setup',
    narration: 'frase',
    shotDescription: 'plano',
    characterIds: [],
  })),
});

function conDuraciones(duraciones) {
  const story = parseStoryResponse(SCRIPT, 'x');
  story.scenes.forEach((s, i) => {
    s.targetDuration = duraciones[i];
    s.status = 'approved';
  });
  return story;
}

test('el minimo es 60 segundos, el umbral de TikTok', () => {
  assert.equal(MIN_MONETIZABLE_SEC, 60);
});

test('un video de 68 segundos ya cumple', () => {
  const story = conDuraciones([4, 9, 9, 9, 9, 9, 9, 10]);
  assert.equal(totalDuration(story, { requireApproval: true }), 68);
  assert.equal(secondsToMonetizable(story, { requireApproval: true }), 0);
});

test('un video de 56 segundos informa exactamente lo que falta', () => {
  // Es el caso real que motivo la funcion: 56s se queda corto y hay que
  // decir cuantos segundos anadir, no solo avisar de que "falta".
  const story = conDuraciones([4, 9, 9, 9, 9, 8, 8, 0]);
  const total = totalDuration(story, { requireApproval: true });
  assert.equal(total, 56);
  assert.equal(secondsToMonetizable(story, { requireApproval: true }), 4);
});

test('un video de 60 segundos exactos ya cumple', () => {
  const story = conDuraciones([4, 8, 8, 8, 8, 8, 8, 8]);
  assert.equal(totalDuration(story, { requireApproval: true }), 60);
  assert.equal(secondsToMonetizable(story, { requireApproval: true }), 0);
});

test('un video largo no reporta segundos faltantes', () => {
  const story = conDuraciones([5, 12, 12, 12, 12, 12, 12, 12]);
  assert.equal(secondsToMonetizable(story, { requireApproval: true }), 0);
});

test('los planos no aprobados no cuentan cuando la curacion es obligatoria', () => {
  const story = conDuraciones([5, 10, 10, 10, 10, 10, 10, 10]);

  assert.equal(totalDuration(story, { requireApproval: true }), 75);

  // Si se descarta uno, la duracion baja y puede quedarse corta.
  story.scenes[0].status = 'rejected';
  assert.equal(totalDuration(story, { requireApproval: true }), 70);
});

test('sin curacion obligatoria solo se excluyen los descartados', () => {
  const story = conDuraciones([5, 10, 10, 10, 10, 10, 10, 10]);
  story.scenes[0].status = 'rejected'; // 5s fuera
  story.scenes[1].status = 'draft';    // 10s dentro

  // En modo desarrollo solo se cae lo descartado: el borrador suma.
  assert.equal(totalDuration(story, { requireApproval: false }), 70);
});

test('los planos sin duracion no rompen el calculo', () => {
  const story = conDuraciones([0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(totalDuration(story, { requireApproval: true }), 0);
  assert.equal(secondsToMonetizable(story, { requireApproval: true }), 60);
});

test('duplicar un plano alarga el video, pero hay que aprobarlo', async () => {
  const { duplicateScene } = await import('../dist/pipeline.js');
  const story = conDuraciones([4, 10, 10, 10, 10, 10, 10, 10]);
  const antes = totalDuration(story, { requireApproval: true });

  duplicateScene(story, 's8');

  // El duplicado nace sin aprobar, igual que en la interfaz: no cuenta todavia.
  assert.equal(story.scenes.length, 9);
  assert.equal(totalDuration(story, { requireApproval: true }), antes);

  // Al aprobarlo, ya suma su duracion.
  story.scenes[8].status = 'approved';
  assert.equal(totalDuration(story, { requireApproval: true }), antes + 10);
});