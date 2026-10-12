/**
 * Pruebas del generador de ideas aleatorias.
 *
 * Lo que importa aqui no es que las frases suenen bien, sino dos garantias:
 * que no se repita dentro de un lote ni entre lotes, y que el indice sea
 * reversible para poder detectar usos sin comparar textos.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ideaFromIndex,
  suggestIdeas,
  remainingCombinations,
  TOTAL_COMBINATIONS,
  HEROES,
  CONFLICTOS,
} from '../dist/ideas.js';

test('el indice se traduce en una premisa completa sin marcadores sin sustituir', () => {
  for (const i of [0, 1, 42, 999, 12345, 500000, TOTAL_COMBINATIONS - 1]) {
    const idea = ideaFromIndex(i);
    assert.ok(idea.topic.length > 40, `premise demasiado corta en ${i}`);
    assert.doesNotMatch(idea.topic, /\{[hal]\}/, `quedo un marcador sin sustituir en ${i}: ${idea.topic}`);
  }
});

test('los articulos concuerdan con el genero', () => {
  // "un higo" y "una fresa", no al reves.
  for (let i = 0; i < 300; i++) {
    const idea = ideaFromIndex(i * 977);
    assert.doesNotMatch(idea.topic, /\buna higo\b/);
    assert.doesNotMatch(idea.topic, /\bun fresa\b/);
    assert.doesNotMatch(idea.topic, /\buna platano\b/);
    assert.doesNotMatch(idea.topic, /\bun manzana\b/);
  }
});

test('el mismo indice produce siempre la misma premisa', () => {
  assert.equal(ideaFromIndex(777).topic, ideaFromIndex(777).topic);
  assert.equal(ideaFromIndex(777).seed, ideaFromIndex(777).seed);
});

test('indices fuera de rango se normalizan en vez de romper', () => {
  // Negativos cuentan desde el final, como en un array.
  assert.equal(ideaFromIndex(-5).index, TOTAL_COMBINATIONS - 5);
  assert.equal(ideaFromIndex(-1).index, TOTAL_COMBINATIONS - 1);

  // wrapping en ambos sentidos.
  assert.equal(ideaFromIndex(TOTAL_COMBINATIONS).index, 0);
  assert.equal(ideaFromIndex(TOTAL_COMBINATIONS + 42).index, 42);

  // Un indice enorme se reduce sin perder precision ni reventar.
  const enorme = ideaFromIndex(1e12);
  assert.ok(enorme.index >= 0 && enorme.index < TOTAL_COMBINATIONS);
  assert.ok(enorme.topic.length > 40);

  // Los valores no enteros se truncan en vez de propagar NaN.
  assert.ok(ideaFromIndex(7.9).index === 7);
});

test('el lote no repite ni historias ni indices', () => {
  const ideas = suggestIdeas([], 10, 555);
  const indices = ideas.map((i) => i.index);
  assert.equal(new Set(indices).size, indices.length, 'indices repetidos en el lote');
  assert.equal(new Set(ideas.map((i) => i.topic)).size, ideas.length, 'premisas repetidas');
});

test('el lote cambia de nucleo dramatico, no solo de fruta', () => {
  // El fallo original: el recorrido de uno en uno solo variaba el primer
  // campo, asi que las diez ideas eran la misma con distinta fruta.
  const ideas = suggestIdeas([], 10, 555);
  const conflictos = new Set(
    ideas.map((i) => {
      const m = i.topic.match(/: (.*?), (y |pero |y justo)/);
      return m ? m[1] : i.topic;
    }),
  );
  assert.ok(
    conflictos.size >= 5,
    `solo ${conflictos.size} conflictos distintos entre 10 ideas`,
  );
});

test('las ideas excluyen las ya usadas', () => {
  const primero = suggestIdeas([], 4, 2024);
  const usados = primero.map((i) => i.index);
  const segundo = suggestIdeas(usados, 4, 2024);

  for (const idea of segundo) {
    assert.ok(!usados.includes(idea.index), `repitio la idea ${idea.index}`);
  }
});

test('el lote es distinto al pedirlo dos veces seguidas', () => {
  const a = suggestIdeas([], 5, 1000).map((i) => i.index);
  const b = suggestIdeas([], 5, 1001).map((i) => i.index);
  const comunes = a.filter((i) => b.includes(i));
  assert.equal(comunes.length, 0, `se repitieron ${comunes.length} entre dos clics seguidos`);
});

test('500 ideas seguidas no repiten ninguna', () => {
  const historial = [];
  for (let i = 0; i < 500; i++) {
    const idea = suggestIdeas(historial, 1, Date.now() + i * 104729)[0];
    assert.ok(idea, `sin ideas en la vuelta ${i}`);
    assert.ok(!historial.includes(idea.index), `repetida en la vuelta ${i}`);
    historial.push(idea.index);
  }
  assert.equal(historial.length, 500);
});

test('las combinaciones restantes se calculan bien', () => {
  assert.equal(remainingCombinations(0), TOTAL_COMBINATIONS);
  assert.equal(remainingCombinations(10), TOTAL_COMBINATIONS - 10);
  assert.equal(remainingCombinations(TOTAL_COMBINATIONS + 100), 0, 'nunca negativo');
});

test('el catalogo tiene tamano suficiente para no agotarse', () => {
  // Publicando dos veces al dia, 1,18 millones de combinaciones dan para
  // casi 1.600 años. El limite real no es la variedad.
  assert.ok(TOTAL_COMBINATIONS > 1_000_000);
  assert.ok(HEROES.length >= 12);
  assert.ok(CONFLICTOS.length >= 10);
});

test('pedir mas ideas de las disponibles devuelve las que hay', () => {
  const muchas = Array.from({ length: TOTAL_COMBINATIONS - 3 }, (_, i) => i);
  const ideas = suggestIdeas(muchas, 10, 1);
  assert.ok(ideas.length <= 10);
  for (const idea of ideas) {
    assert.ok(!muchas.includes(idea.index));
  }
});

test('con todo el catalogo usado no lanza, devuelve vacio', () => {
  const todo = Array.from({ length: TOTAL_COMBINATIONS }, (_, i) => i);
  assert.deepEqual(suggestIdeas(todo, 5, 1), []);
});