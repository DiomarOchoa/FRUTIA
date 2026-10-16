/**
 * Prueba una clave contra varios proveedores de imagen para descubrir a cual
 * pertenece, sin imprimirla nunca.
 *
 * El formato de la clave que dio el usuario es `algo_id:secreto`, que es el de
 * fal.ai. Pero se pidio una clave de Pixazo, asi que se prueban los dos: si el
 * mismo identificador sirve en los dos gateways, mejor saberlo antes de
 * integrar nada.
 *
 * La clave va en la variable de entorno FRUTIA_PROBE_KEY; este archivo solo
 * la lee y no la escribe en ningun lado.
 */

const KEY = process.env.FRUTIA_PROBE_KEY;
if (!KEY) {
  console.error('Falta FRUTIA_PROBE_KEY.');
  process.exit(1);
}

console.log(`Clave: ${KEY.slice(0, 8)}...${KEY.slice(-4)}  (${KEY.length} caracteres)\n`);

const imagenesFicticias = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const objetivos = [
  {
    nombre: 'Pixazo  (gateway.pixazo.ai)',
    url: 'https://gateway.pixazo.ai/flux/text-to-image',
    cabeceras: (k) => ({ 'Ocp-Apim-Subscription-Key': k }),
    cuerpo: { prompt: 'a red apple on a white background' },
  },
  {
    nombre: 'fal.ai  (fal.run)',
    url: 'https://fal.run/fal-ai/flux/dev',
    cabeceras: (k) => ({ Authorization: `Key ${k}` }),
    cuerpo: { prompt: 'a red apple on a white background', image_size: { width: 1024, height: 1024 } },
  },
];

for (const objetivo of objetivos) {
  const t0 = Date.now();

  try {
    const res = await fetch(objetivo.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...objetivo.cabeceras(KEY) },
      body: JSON.stringify(objetivo.cuerpo),
      signal: AbortSignal.timeout(150_000),
    });

    const texto = await res.text();
    const seg = ((Date.now() - t0) / 1000).toFixed(1);

    if (res.ok) {
      let donde = '(respuesta sin URL reconocible)';
      try {
        const j = JSON.parse(texto);
        donde = j.images?.[0]?.url ?? j.image?.url ?? j.output?.url ?? j.url ?? donde;
      } catch { /* no es JSON */ }

      console.log(`${objetivo.nombre}  FUNCIONA en ${seg}s`);
      console.log(`   -> ${String(donde).slice(0, 110)}`);
    } else {
      console.log(`${objetivo.nombre}  ${res.status} en ${seg}s`);
      console.log(`   ${texto.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  } catch (error) {
    const seg = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${objetivo.nombre}  ERROR en ${seg}s: ${error.message.slice(0, 90)}`);
  }

  console.log('');
}

// Y una comprobacion de solo lectura para ver que informs del credito.
try {
  const res = await fetch('https://fal.ai/api/v1/account', {
    headers: { Authorization: `Key ${KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  const t = await res.text();
  console.log(`fal.ai /account  ${res.status}`);
  if (res.ok) {
    // No se imprime entero: puede traer datos de facturacion.
    try {
      const j = JSON.parse(t);
      console.log(`   saldo/conceptos: ${JSON.stringify(j).slice(0, 220)}`);
    } catch { console.log(`   ${t.slice(0, 160)}`); }
  } else {
    console.log(`   ${t.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
} catch (error) {
  console.log(`fal.ai /account  ERROR: ${error.message.slice(0, 80)}`);
}
