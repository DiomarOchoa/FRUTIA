/**
 * Degradacion de Pollinations cuando la clave se queda sin saldo.
 *
 * El fallo que motivó estas pruebas es real y caro: la clave secreta de
 * Pollinations empieza con algo de saldo, lo gasta y pasa a responder
 * `402 Insufficient balance`. Ese 402 significa "no hay dinero", NO "vas
 * demasiado rapido", pero el codigo lo trataba igual que un 429 de
 * ritmo: reintentaba tres veces, esperaba un minuto entero y al final
 * fallaba, dejando al usuario sin una sola imagen.
 *
 * El acceso anonimo de toda la vida sigue respondiendo gratis. Lo que se
 * fija aqui es que la app baja a el sola, sin intervencion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PollinationsImageProvider, RateLimiter } from '../dist/providers/image-pollinations.js';

/**
 * El limitador debe dejar pasar la segunda peticion.
 *
 * Este es el bug mas caro que ha tenido el proyecto. El limitador estaba
 * escrito con `for (;;)` y, al reservar el hueco, empujaba `nextFreeAt` hacia
 * adelante; al despertar, la espera siguiente era identica y `wait` nunca
 * llegaba a cero. La primera imagen salia y la segunda se quedaba esperando
 * para siempre: proceso vivo, cero imagenes, indefinidamente.
 *
 * Los intervalos son de milisegundos, no de segundos, para que si vuelve a
 * romperse el fallo aparezca en menos de un segundo.
 */

test('tres esperas seguidas terminan y reservan tres huecos', async () => {
  const limiter = new RateLimiter(120);
  const marcas = [];

  const t0 = Date.now();
  for (let i = 0; i < 3; i++) {
    await limiter.acquire();
    marcas.push(Date.now() - t0);
  }

  // La primera no espera: sale de inmediato.
  assert.ok(marcas[0] < 100, `la primera espero ${marcas[0]} ms`);

  // Las siguientes si respetan el intervalo.
  assert.ok(marcas[1] - marcas[0] >= 100, `la segunda tardo ${marcas[1] - marcas[0]} ms`);
  assert.ok(marcas[2] - marcas[1] >= 100, `la tercera tardo ${marcas[2] - marcas[1]} ms`);

  assert.ok(marcas[2] < 2000, `tres esperas tardaron ${marcas[2]} ms: no termina`);
});

test('esperas concurrentes se encolan en vez de solaparse', async () => {
  const limiter = new RateLimiter(100);
  const marcas = [];
  const t0 = Date.now();

  // Las tres piden a la vez, que es como llamarlas de verdad.
  await Promise.all(
    [1, 2, 3].map(async (n) => {
      await limiter.acquire();
      marcas.push({ n, ms: Date.now() - t0 });
    }),
  );

  marcas.sort((a, b) => a.ms - b.ms);

  assert.equal(marcas.length, 3);
  assert.ok(marcas[0].ms < 100, 'la primera sale de inmediato');
  assert.ok(marcas[1].ms >= 100, 'la segunda respeta su turno');
  assert.ok(marcas[2].ms >= 200, 'la tercera tambien');
});

test('tres imagenes seguidas salen sin quedarse esperando', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    text: async () => '',
  });

  try {
    const p = new PollinationsImageProvider({ minIntervalSec: 0.05 });

    const t0 = Date.now();
    await p.generate({ prompt: 'a' });
    await p.generate({ prompt: 'b' });
    await p.generate({ prompt: 'c' });
    const total = Date.now() - t0;

    assert.equal(p.served, 3, 'las tres llegaron al servicio');
    assert.ok(total < 5000, `tres imagenes tardaron ${total} ms: se quedo esperando`);
  } finally {
    globalThis.fetch = original;
  }
});


/** Sustituye fetch global por uno falso y devuelve las peticiones recibidas. */
function conFetchFalso(respuestas, cuerpo) {
  const llamadas = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    llamadas.push({ url: u, headers: opts?.headers ?? {} });
    const r = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)];
    return {
      ok: r.status < 400,
      status: r.status,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array(cuerpo ?? [137, 80, 78, 71]).buffer,
      text: async () => r.texto ?? '',
    };
  };

  return {
    llamadas,
    restaurar: () => { globalThis.fetch = original; },
  };
}

test('baja a modo anonimo cuando la clave no tiene saldo', async () => {
  const sinSaldo = {
    status: 402,
    texto: JSON.stringify({
      error: { message: 'Insufficient balance. This request costs ~0.0020 pollen, but your available balance is 0.0008.', code: 'INSUFFICIENT' },
    }),
  };
  const ok = { status: 200 };

  const f = conFetchFalso([sinSaldo, ok], Buffer.from([1, 2, 3, 4]));
  try {
    const p = new PollinationsImageProvider({ token: 'sk_secreto' });

    assert.equal(p.hasToken, true, 'arranca usando la clave');

    const img = await p.generate({ prompt: 'una manzana' });

    assert.equal(img.base64, Buffer.from([1, 2, 3, 4]).toString('base64'));
    assert.equal(p.hasToken, false, 'ya no usa la clave: cayo a anonimo');

    // La primera peticion va al endpoint nuevo con la cabecera Authorization.
    assert.match(f.llamadas[0].url, /^https:\/\/gen\.pollinations\.ai\/image\//);
    assert.match(String(f.llamadas[0].headers.Authorization ?? ''), /^Bearer sk_secreto$/);

    // La segunda va al endpoint anonimo y sin cabecera de autorizacion.
    assert.match(f.llamadas[1].url, /^https:\/\/image\.pollinations\.ai\/prompt\//);
    assert.equal(f.llamadas[1].headers.Authorization, undefined, 'el anonimo no lleva token');
    // La clave no se cuela por query string cuando esta en modo anonimo:
    // pasarla ahi solo volveria a pedir saldo y reproduciria el 402.
    assert.doesNotMatch(f.llamadas[1].url, /[?&]key=/, 'sin key= en modo anonimo');
  } finally {
    f.restaurar();
  }
});

test('un 402 de ritmo NO dispara el modo anonimo', async () => {
  // El anonimo responde 402 tambien cuando va demasiado rapido. Confundir
  // los dos casos haria que Pollinations se degradara sola sin motivo y
  // perdiera la velocidad del acceso con clave.
  const demasiadoRapido = { status: 402, texto: 'Too many requests' };
  const ok = { status: 200 };

  const f = conFetchFalso([demasiadoRapido, ok], Buffer.from([9, 9]));
  try {
    const p = new PollinationsImageProvider({ token: 'sk_secreto', minIntervalSec: 0 });
    await p.generate({ prompt: 'test' });

    assert.equal(p.hasToken, true, 'sigue con la clave');
    assert.match(f.llamadas[1].url, /^https:\/\/gen\.pollinations\.ai\/image\//);
  } finally {
    f.restaurar();
  }
});

test('sin clave desde el principio se reportan 8 intentos', async () => {
  const p = new PollinationsImageProvider({});
  assert.equal(p.hasToken, false);
  assert.equal(p.modoAnonimo, false, 'nunca hubo clave que se quedara sin saldo');
  // `intentosMax` es `private` en TypeScript, que es una restriction de
  // compilacion y no de ejecucion: desde aqui se ve igual. Fija el numero de
  // intentos que decide si una imagen sale o no.
  assert.equal(p.intentosMax(), 8, 'sin clave hay que insistir mas');
});

test('con clave utilizable se reportan 3 intentos', async () => {
  const p = new PollinationsImageProvider({ token: 'sk_secreto' });
  assert.equal(p.intentosMax(), 3, 'con clave reintentar de mas solo alarga la espera');
});

test('el limite de peticiones se recalcula al caer a anonimo', async () => {
  const p = new PollinationsImageProvider({ token: 'sk_secreto' });
  assert.equal(p.intervalo({}), 1000, 'con clave se va rapido');

  // El mismo objeto, ya degradado, tiene que separar mas las peticiones.
  p.anonMode = true;
  assert.equal(p.intervalo({}), 20_000, 'el anonimo necesita separacion');
});
