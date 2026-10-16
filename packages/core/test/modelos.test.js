/**
 * Cascada de modelos de texto.
 *
 * Este es el bug que impidio generar la primera frutinovela. Google devuelve
 * 503 "high demand" cuando satura un modelo, y la cascada solo avanzaba al
 * siguiente cuando el modelo habia sido RETIRADO (404). Un 503 no es una
 * retirada, se propagaba, y la app se quedaba sin guion aunque los dos
 * modelos siguientes de la lista respondieran perfectamente.
 *
 * Medido el 12 de octubre de 2026:
 *   gemini-3.8-flash  503 tres veces seguidas
 *   gemini-3.7-flash  OK en 6,7 s
 *   gemini-3.5-flash  OK en 0,9 s
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  withModelFallback,
  isModelUnavailable,
  ModelUnavailableError,
  ModelRetiredError,
} from '../dist/providers/models.js';
import { LlmProvider } from '../dist/providers/llm.js';

/** Clasifica los 429/503 que el servicio devuelve de verdad. */
test('un 503 de saturacion permite cambiar de modelo', () => {
  assert.equal(
    isModelUnavailable(503, 'This model is currently experiencing high demand.'),
    true,
  );
});

test('un 429 de cuota permite cambiar de modelo', () => {
  assert.equal(
    isModelUnavailable(429, 'Quota exceeded for metric: free_tier_requests, limit: 20, model: gemini-3.8-flash'),
    true,
  );
});

test('un 404 de retirada NO cuenta como indisponible', () => {
  // El 404 ya tiene su propia via: es una retirada, no una caida temporal.
  assert.equal(isModelUnavailable(404, 'not found'), false);
});

test('un 400 de contenido invalido NO permite cambiar de modelo', () => {
  // Cambiar de modelo por un prompt malo gasta cuota a cambio de nada.
  assert.equal(isModelUnavailable(400, 'Invalid prompt'), false);
});

test('el 429 de cuota de TTS (402 sin saldo) no es del LLM', () => {
  assert.equal(isModelUnavailable(402, 'Insufficient balance'), false);
});

test('la cascada avanza cuando se le pide', async () => {
  const probados = [];

  const r = await withModelFallback(
    ['a', 'b', 'c'],
    async (m) => {
      probados.push(m);
      if (m === 'c') return 'ok';
      throw new ModelUnavailableError(`503 en ${m}`);
    },
    (e) => e instanceof ModelUnavailableError,
  );

  assert.equal(r, 'ok');
  assert.deepEqual(probados, ['a', 'b', 'c']);
});

test('sin permiso explicito, un 503 se propaga y no gasta mas cuota', async () => {
  let llamadas = 0;

  await assert.rejects(
    () => withModelFallback(['a', 'b'], async () => {
      llamadas++;
      throw new ModelUnavailableError('503');
    }),
  );

  assert.equal(llamadas, 1, 'imagenes no deben cambiar de modelo por saturacion');
});

test('una retirada sigue avanzando aunque no se pida permiso', async () => {
  const probados = [];
  const r = await withModelFallback(['a', 'b'], async (m) => {
    probados.push(m);
    if (m === 'a') throw new ModelRetiredError('404 retirado');
    return 'ok';
  });

  assert.equal(r, 'ok');
  assert.deepEqual(probados, ['a', 'b']);
});

test('el LLM pasa de un modelo saturado al siguiente que responde', async () => {
  const original = globalThis.fetch;
  const pedidos = [];

  globalThis.fetch = async (url) => {
    const modelo = String(url).match(/models\/([^:]+):/)?.[1] ?? '?';
    pedidos.push(modelo);

    if (modelo === 'gemini-3.8-flash') {
      return {
        ok: false, status: 503, headers: { get: () => 'application/json' },
        arrayBuffer: async () => new Uint8Array(0).buffer,
        text: async () => 'This model is currently experiencing high demand.',
      };
    }

    return {
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'listo' }] } }] }),
      arrayBuffer: async () => new Uint8Array(0).buffer,
      text: async () => '',
    };
  };

  try {
    const llm = new LlmProvider({ apiKey: 'k' });
    const r = await llm.complete('sistema', 'usuario');

    assert.equal(r, 'listo', 'el guion salio del segundo modelo');
    assert.deepEqual(pedidos, ['gemini-3.8-flash', 'gemini-3.7-flash']);
  } finally {
    globalThis.fetch = original;
  }
});

test('un 400 de contenido no hace saltar al modelo siguiente', async () => {
  const original = globalThis.fetch;
  let llamadas = 0;

  globalThis.fetch = async () => {
    llamadas++;
    return {
      ok: false, status: 400, headers: { get: () => 'application/json' },
      arrayBuffer: async () => new Uint8Array(0).buffer,
      text: async () => 'Invalid prompt',
    };
  };

  try {
    const llm = new LlmProvider({ apiKey: 'k' });
    await assert.rejects(() => llm.complete('s', 'u'));
    assert.equal(llamadas, 1, 'un prompt malo no se arregla cambiando de modelo');
  } finally {
    globalThis.fetch = original;
  }
});

test('el guion avisa cuando TODOS los modelos estan caidos', async () => {
  const original = globalThis.fetch;

  globalThis.fetch = async (url) => ({
    ok: false,
    status: String(url).includes('3.8') ? 503 : 429,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => new Uint8Array(0).buffer,
    text: async () =>
      String(url).includes('3.8')
        ? 'high demand'
        : JSON.stringify({ error: { message: 'Quota exceeded. limit: 20. Please retry in 9h.' } }),
  });

  try {
    const llm = new LlmProvider({ apiKey: 'k' });
    await assert.rejects(
      () => llm.complete('s', 'u'),
      (e) => {
        const m = e.message;
        // Tiene que nombrar los tres modelos: si no, el usuario no sabe que
        // ya se probaron todos y espera en vano.
        assert.match(m, /gemini-3\.8-flash/);
        assert.match(m, /gemini-3\.7-flash/);
        assert.match(m, /gemini-3\.5-flash/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});
