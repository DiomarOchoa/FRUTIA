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

test('el motivo de la degradacion explica cuando vuelve Google', async () => {
  const f = conGoogleMuerto(CUOTA);
  try {
    const p = proveedor();
    await p.generate({ prompt: 'una' });

    assert.match(
      String(p.degradedReason),
      /14 ?h|Pollinations/i,
      'el usuario tiene que saber que son 14 horas y que las imagenes siguen saliendo',
    );
  } finally {
    f.restaurar();
  }
});

test('sin tiempo de reinicio en el 429, Google se descarta por la sesion', async () => {
  const sinFecha = JSON.stringify({
    error: { code: 429, message: 'Quota exceeded for this model.' },
  });
  const f = conGoogleMuerto(sinFecha);
  try {
    const p = proveedor();

    await p.generate({ prompt: 'una' });
    const primera = f.google();

    await p.generate({ prompt: 'dos' });

    assert.equal(f.google(), primera, 'no insiste si no hay fecha de reinicio');
  } finally {
    f.restaurar();
  }
});

test('un 400 de contenido NO apaga Google para el resto de la sesion', async () => {
  // El modo $0 solo se degrada por cuota. Un 400 es del prompt concreto: la
  // siguiente imagen puede estar bien y apagarlo haria perder al proveedor
  // bueno por un error puntual.
  const original = globalThis.fetch;
  let google = 0;

  globalThis.fetch = async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      google++;

      // Solo el primer prompt es invalido; el siguiente sale bien, que es
      // justo lo que hay que comprobar: que un 400 no deja a Google muerto.
      if (google === 1) {
        return {
          ok: false,
          status: 400,
          headers: { get: () => 'application/json' },
          arrayBuffer: async () => new Uint8Array(0).buffer,
          text: async () => JSON.stringify({ error: { message: 'Invalid prompt' } }),
        };
      }

      // Google responde con JSON: el inlineData va dentro, no en el binario.
      const datos = Buffer.from([7]).toString('base64');
      return {
        ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: datos } }] } }] }),
        arrayBuffer: async () => new Uint8Array(0).buffer, text: async () => '',
      };
    }
    return {
      ok: true, status: 200, headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([9]).buffer, text: async () => '',
    };
  };

  try {
    const p = proveedor();

    // El 400 no se degrada a Pollinations: se propaga. Y como no es una
    // retirada de modelo, no se prueban los otros dos: cambiarlos no
    // arreglaria nada y solo gastaria cuota.
    await assert.rejects(() => p.generate({ prompt: 'mala' }));
    assert.equal(google, 1, 'un solo intento: el 400 no se reintenta con otro modelo');

    // Y la siguiente imagen vuelve a intentarlo con Google, y ahora sale de
    // Google, no de Pollinations: el proveedor bueno sigue vivo.
    const r = await p.generate({ prompt: 'buena' });
    assert.equal(r.base64, Buffer.from([7]).toString('base64'), 'salio de Google');
    assert.equal(p.lastBackend, 'gemini', 'no se degrado a Pollinations');
    assert.equal(google, 2, 'sigue probando Google tras un 400');
  } finally {
    globalThis.fetch = original;
  }
});

test('el tiempo de reinicio se lee bien con horas, minutos y segundos', async () => {
  const p = proveedor();
  // `enSegundos` es privado en TypeScript (restriccion de compilacion), pero
  // desde aqui se ve igual.
  assert.equal(p.enSegundos('14h31m13s'), 14 * 3600 + 31 * 60 + 13);
  assert.equal(p.enSegundos('2h'), 7200);
  assert.equal(p.enSegundos('45m30s'), 45 * 60 + 30);
  assert.equal(p.enSegundos('nada'), null, 'si no hay fecha, no inventa una');
});
