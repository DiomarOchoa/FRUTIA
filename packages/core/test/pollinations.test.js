/**
 * Caida automatica al endpoint anonimo de Pollinations.
 *
 * Situacion medida: la clave del usuario se queda con 0,0008 de Pollen cuando
 * cada imagen cuesta 0,0020. Pollinations responde `402 Insufficient balance`,
 * que NO es "vas demasiado rapido" sino "no hay dinero": reintentar tres veces
 * solo gastaba un minuto de espera y fallaba igual. El usuario se quedaba sin
 * una sola imagen y sin ninguna salida.
 *
 * La salida existe y es gratis: el endpoint anonimo de toda la vida, sin clave
 * y sin cuota. Acierta aproximadamente la mitad, asi que lo que hace falta es
 * insistir con separacion entre llamadas.
 *
 * Estos tests fijan esa distincion, que es la parte que se confunde:
 *   · 402 CON clave y texto de saldo  -> cambiar de modo, no reintentar igual
 *   · 402 en modo anonimo             -> "demasiado rapido", reintentar
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PollinationsImageProvider, RateLimiter } from '../dist/providers/image-pollinations.js';

/** Fetch falso con una secuencia de respuestas y registro de las peticiones. */
function conRespuestas(secuencia) {
  const peticiones = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    peticiones.push({ url: u, headers: opts?.headers ?? {} });

    const r = secuencia[Math.min(peticiones.length - 1, secuencia.length - 1)];
    if (r.imagen) {
      return {
        ok: true, status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => new Uint8Array(r.imagen).buffer,
        text: async () => '',
      };
    }

    return {
      ok: false, status: r.status,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () => new Uint8Array(0).buffer,
      text: async () => r.texto ?? '',
    };
  };

  return { peticiones, restaurar: () => { globalThis.fetch = original; } };
}

const SIN_SALDO = {
  status: 402,
  texto: JSON.stringify({
    error: { message: 'Insufficient balance. This request costs ~0.0020 pollen, but your available balance is 0.0008.' },
  }),
};

/**
 * Fetch que simula al servidor cortando la conexion sin responder nada.
 *
 * Es el tercer fallo del endpoint anonimo y el mas dificil de tratar: no hay
 * codigo HTTP que mirar, `fetch` lanza y el error sale como TypeError. Un
 * codigo que decide reintentar por el status nunca lo ve.
 */
function conConexionCortada(cortes, respuestaFinal) {
  const estado = { peticiones: 0 };
  const original = globalThis.fetch;

  globalThis.fetch = async () => {
    estado.peticiones++;
    if (estado.peticiones <= cortes) {
      const err = new TypeError('fetch failed');
      err.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
      throw err;
    }
    return {
      ok: true, status: 200, headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array(respuestaFinal.imagen).buffer,
      text: async () => '',
    };
  };

  return { get peticiones() { return estado.peticiones; }, restaurar: () => { globalThis.fetch = original; } };
}

test('la clave sin saldo no se abandona: se marca como anonimo', async () => {
  const f = conRespuestas([SIN_SALDO, { imagen: [1, 2, 3, 4] }]);
  try {
    const p = new PollinationsImageProvider({ token: 'sk_secreto', minIntervalSec: 0.01 });

    assert.equal(p.hasToken, true, 'arranca usando la clave');
    assert.equal(p.modoAnonimo, false);

    const img = await p.generate({ prompt: 'una manzana' });

    assert.equal(img.base64, Buffer.from([1, 2, 3, 4]).toString('base64'));
    assert.equal(p.modoAnonimo, true, 'cayo al anonimo');
    assert.equal(p.hasToken, false, 'ya no dice que tiene clave');
  } finally {
    f.restaurar();
  }
});

test('la primera peticion usa la clave y la segunda el endpoint anonimo', async () => {
  const f = conRespuestas([SIN_SALDO, { imagen: [1] }]);
  try {
    await new PollinationsImageProvider({ token: 'sk', minIntervalSec: 0.01 })
      .generate({ prompt: 'x' });

    assert.match(f.peticiones[0].url, /^https:\/\/gen\.pollinations\.ai\/image\//);
    assert.match(String(f.peticiones[0].headers.Authorization ?? ''), /^Bearer sk$/);

    assert.match(f.peticiones[1].url, /^https:\/\/image\.pollinations\.ai\/prompt\//);
    assert.equal(f.peticiones[1].headers.Authorization, undefined,
      'el anonimo no lleva cabecera de autorizacion');
  } finally {
    f.restaurar();
  }
});

test('un 402 de ritmo en modo anonimo SI se reintenta', async () => {
  // En el endpoint anonimo el 402 significa "demasiado rapido", no "sin
  // saldo". Abortar a la primera seria cambiar medio acierto por un fallo.
  const f = conRespuestas([{ status: 402, texto: '' }, { status: 402, texto: '' }, { imagen: [7] }]);
  try {
    const p = new PollinationsImageProvider({ minIntervalSec: 0.01 });

    const img = await p.generate({ prompt: 'x' });

    assert.equal(img.base64, Buffer.from([7]).toString('base64'));
    assert.equal(f.peticiones.length, 3, 'insistio hasta que salio');
  } finally {
    f.restaurar();
  }
});

test('un 404 en modo anonimo SI se reintenta (aun no estaba lista)', async () => {
  // Medido: una URL de 1.303 caracteres devolvio 404 y, sin cambiar nada,
  // veinte segundos despues devolvio 200 con 67 KB de imagen. El 404 del
  // endpoint anonimo significa "todavia no", no "este prompt no existe".
  const f = conRespuestas([{ status: 404, texto: '404 Not Found' }, { imagen: [5] }]);
  try {
    const p = new PollinationsImageProvider({ minIntervalSec: 0.01 });

    const img = await p.generate({ prompt: 'ficha larga' });

    assert.equal(img.base64, Buffer.from([5]).toString('base64'));
    assert.equal(f.peticiones.length, 2, 'insistio tras el 404');
  } finally {
    f.restaurar();
  }
});

test('una conexion cortada se reintenta (no hay ni codigo HTTP)', async () => {
  // El tercero de los tres fallos del endpoint anonimo. Llega como `fetch
  // failed` con `SocketError: other side closed` y cero bytes leidos: no hay
  // status, asi que un codigo que solo mira el status lo tira sin intentar.
  const f = conConexionCortada(1, { imagen: [6] });
  try {
    const p = new PollinationsImageProvider({ minIntervalSec: 0.01 });

    const img = await p.generate({ prompt: 'x' });

    assert.equal(img.base64, Buffer.from([6]).toString('base64'));
    assert.equal(f.peticiones, 2, 'insistio tras el corte de conexion');
  } finally {
    f.restaurar();
  }
});

test('un 404 CON clave no se reintenta: ahi si es un error real', async () => {
  const f = conRespuestas([{ status: 404, texto: 'Not Found' }, { imagen: [1] }]);
  try {
    const p = new PollinationsImageProvider({ token: 'sk', minIntervalSec: 0.01 });

    await assert.rejects(() => p.generate({ prompt: 'x' }));
    assert.equal(f.peticiones.length, 1, 'con clave un 404 se propaga sin insistir');
  } finally {
    f.restaurar();
  }
});

test('sin clave y con anonimo permitido, funciona directo', async () => {
  const f = conRespuestas([{ imagen: [9] }]);
  try {
    const p = new PollinationsImageProvider({ minIntervalSec: 0.01 });

    const img = await p.generate({ prompt: 'x' });

    assert.equal(img.base64, Buffer.from([9]).toString('base64'));
    assert.equal(f.peticiones[0].url.startsWith('https://image.pollinations.ai/prompt/'), true);
    // Sin clave no hay "caida": se nacio anonimo.
    assert.equal(p.modoAnonimo, false);
  } finally {
    f.restaurar();
  }
});

test('con allowAnonymous=false y sin clave, se explica que hacer', async () => {
  const p = new PollinationsImageProvider({ allowAnonymous: false });

  await assert.rejects(
    () => p.generate({ prompt: 'x' }),
    /POLLINATIONS_API_KEY|enter\.pollinations\.ai/,
    'el error tiene que decir donde crear la clave',
  );
});

test('el cambio de modo no gasta un intento', async () => {
  // Si el 402 de saldo consumiera un intento, con dos intentos la caida al
  // anonimo se quedaria sin margen para trabajar.
  const f = conRespuestas([SIN_SALDO, { status: 402, texto: '' }, { imagen: [3] }]);
  try {
    const p = new PollinationsImageProvider({ token: 'sk', minIntervalSec: 0.01 });
    const img = await p.generate({ prompt: 'x' });

    assert.equal(img.base64, Buffer.from([3]).toString('base64'));
    assert.equal(f.peticiones.length, 3);
  } finally {
    f.restaurar();
  }
});

test('el limite se recalcula al caer a anonimo', async () => {
  const conClave = new PollinationsImageProvider({ token: 'sk' });
  assert.equal(conClave.intervalo({}), 1000, 'con clave se va rapido');

  conClave.anonimo = true;
  assert.equal(conClave.intervalo({}), 20_000,
    'el anonimo necesita 20 s entre llamadas o acierta casi siempre el 402');
});

/**
 * El limitador es global a proposito y no puede quedarse esperando para
 * siempre: en una version anterior estaba dentro de un `for (;;)` que nunca
 * terminaba, porque al reservar el hueco empujaba el reloj hacia adelante. La
 * segunda imagen de la historia se quedaba colgada para siempre. Medido: 17
 * minutos de proceso vivo sin sacar una sola imagen.
 */
test('tres esperas seguidas terminan y reservan tres huecos', async () => {
  const limiter = new RateLimiter(120);
  const marcas = [];

  const t0 = Date.now();
  for (let i = 0; i < 3; i++) {
    await limiter.acquire();
    marcas.push(Date.now() - t0);
  }

  assert.ok(marcas[0] < 100, `la primera espero ${marcas[0]} ms`);
  assert.ok(marcas[1] - marcas[0] >= 100, `la segunda tardo ${marcas[1] - marcas[0]} ms`);
  assert.ok(marcas[2] - marcas[1] >= 100, `la tercera tardo ${marcas[2] - marcas[1]} ms`);
  assert.ok(marcas[2] < 2000, `tres esperas tardaron ${marcas[2]} ms: no termina`);
});

test('esperas concurrentes se encolan en vez de solaparse', async () => {
  const limiter = new RateLimiter(100);
  const marcas = [];
  const t0 = Date.now();

  await Promise.all([1, 2, 3].map(async (n) => {
    await limiter.acquire();
    marcas.push({ n, ms: Date.now() - t0 });
  }));

  marcas.sort((a, b) => a.ms - b.ms);
  assert.equal(marcas.length, 3);
  assert.ok(marcas[0].ms < 100, 'la primera sale de inmediato');
  assert.ok(marcas[1].ms >= 100, 'la segunda respeta su turno');
  assert.ok(marcas[2].ms >= 200, 'la tercera tambien');
});

test('tres imagenes seguidas salen sin quedarse esperando', async () => {
  const f = conRespuestas([{ imagen: [1, 2, 3] }]);
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
    f.restaurar();
  }
});
