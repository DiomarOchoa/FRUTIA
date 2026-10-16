/**
 * La cascada de imagenes no debe desperdiciar llamadas en un proveedor muerto.
 *
 * El fallo medido: con la cuota diaria de Gemini agotada, cada imagen
 * recorria los TRES modelos de Google antes de caer a Pollinations. Trece
 * imagenes de una frutinovela son treinta y nueve peticiones que no podian
 * salir, cada una con su latencia de red. Medido en produccion: diecisiete
 * minutos sin producir una sola imagen.
 *
 * Estos tests fijan que Google, una vez muerto por cuota, no vuelve a
 * intentarse hasta que la cuota se reinicie.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ImageProvider } from '../dist/providers/image.js';

/** Counta peticiones a Google y devuelve un fetch falso que da 429 ahi. */
function conGoogleMuerto(cuerpo, bytes) {
  const porModelo = {};
  let aPollinations = 0;
  const original = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const u = String(url);

    if (u.includes('generativelanguage.googleapis.com')) {
      const modelo = u.match(/models\/([^:]+):/)?.[1] ?? 'desconocido';
      porModelo[modelo] = (porModelo[modelo] ?? 0) + 1;

      return {
        ok: false,
        status: 429,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => new Uint8Array(0).buffer,
        text: async () => cuerpo,
      };
    }

    aPollinations++;

    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array(bytes ?? [1, 2, 3]).buffer,
      text: async () => '',
    };
  };

  return {
    /** Peticiones a Google, que es lo que hay que vigilar. */
    google: () => Object.values(porModelo).reduce((a, b) => a + b, 0),
    pollinations: () => aPollinations,
    restaurar: () => { globalThis.fetch = original; },
  };
}

/**
 * Proveedor con el intervalo de Pollinations casi a cero.
 *
 * Estos tests cuentan llamadas, no miden tiempos; con el intervalo anonimo real
 * de 20 segundos la suite tardaria minutos.
 */
function proveedor() {
  return new ImageProvider({
    apiKey: 'k',
    prefer: 'auto',
    pollinations: { minIntervalSec: 0.02 },
  });
}

const CUOTA = JSON.stringify({
  error: {
    code: 429,
    message:
      'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20. '
      + 'Please retry in 14h31m13s.',
  },
});

test('Google muerto por cuota: solo se intenta en la primera imagen', async () => {
  const f = conGoogleMuerto(CUOTA);
  try {
    const p = proveedor();

    await p.generate({ prompt: 'una' });
    const trasLaPrimera = f.google();

    await p.generate({ prompt: 'dos' });
    await p.generate({ prompt: 'tres' });
    await p.generate({ prompt: 'cuatro' });

    assert.ok(
      trasLaPrimera > 0,
      'la primera imagen si debe probar Google: no se sabe que esta muerto',
    );
    assert.equal(
      f.google(),
      trasLaPrimera,
      'las imagenes siguientes ya no vuelven a preguntar a Google',
    );
    assert.equal(f.pollinations(), 4, 'las cuatro imagenes salieron igual');
  } finally {
    f.restaurar();
  }
});

test('tras la muerte por cuota, el backend es Pollinations', async () => {
  const f = conGoogleMuerto(CUOTA);
  try {
    const p = proveedor();

    await p.generate({ prompt: 'una' });
    assert.equal(p.lastBackend, 'pollinations', 'cayo a Pollinations');
  } finally {
    f.restaurar();
  }
});
