/**
 * Comprobacion de la concurrencia de generacion de imagenes.
 *
 * El fallo que estos tests fijan es silencioso, que es lo que lo hace grave.
 * El planificador se calculaba asi:
 *
 *   Math.max(1, Math.min(deps.image.recommendedConcurrency, n))
 *
 * Si `recommendedConcurrency` es `undefined`, `Math.min` devuelve `NaN`,
 * `Math.max(1, NaN)` tambien, y `Array.from({ length: NaN })` devuelve un
 * array VACIO. No arranca ni un trabajador, el pipeline termina con exito,
 * el progreso marca "done" y la historia se guarda sin una sola imagen. El
 * usuario ve el guion entero y solo descubre el problema tres etapas mas
 * tarde, cuando el render dice que no hay tomas approved.
 *
 * Medido: los cuatro tests de render y los tres de pipeline fallaban con
 * "Los planos aprobados no tienen imagen ni audio", que es este bug
 * manifestandose cientos de lineas mas abajo de donde estaba la causa.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateImages } from '../dist/pipeline.js';

/** Historia minima: un plano, un personaje, sin nada de archivos. */
function historia() {
  return {
    id: 'test-concurrencia',
    title: 't',
    premise: 'p',
    tone: 'x',
    visualStyleId: 'pixar3d',
    visualStyle: 'prompt',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    characters: [{
      id: 'c1', name: 'Fresa', species: 'fresa', archetype: 'hero',
      visualDescription: 'roja', voiceTone: 'f', personality: 'x',
    }],
    scenes: [
      { id: 's1', index: 1, role: 'hook', narration: 'Uno', shotDescription: 'A',
        characterIds: ['c1'], targetDuration: 3, variants: [], activeVariant: 0,
        attempts: 0, status: 'draft' },
      { id: 's2', index: 2, role: 'setup', narration: 'Dos', shotDescription: 'B',
        characterIds: ['c1'], targetDuration: 3, variants: [], activeVariant: 0,
        attempts: 0, status: 'draft' },
      { id: 's3', index: 3, role: 'conflict', narration: 'Tres', shotDescription: 'C',
        characterIds: ['c1'], targetDuration: 3, variants: [], activeVariant: 0,
        attempts: 0, status: 'draft' },
    ],
  };
}

/** Payloads de prueba: los reales pesan 50 KB o mas. */
const PNG_CHICO = 'iVBORw0KGgo=';
const PNG_GRANDE = Buffer.alloc(4096, 7).toString('base64');

/** Proveedor minimo que devuelve una imagen falsa. */
function proveedor({ concurrency, references = false, bytes = 'grande' } = {}) {
  let llamadas = 0;
  return {
    llamadas: () => llamadas,
    supportsReferenceImages: references,
    // Ojo: cuando `concurrency` es undefined la PROPIEDAD NO EXISTE, que es
    // justo como rompe un proveedor propio sin ese getter.
    ...(concurrency === undefined ? {} : { recommendedConcurrency: concurrency }),
    async generate() {
      llamadas++;
      return { base64: bytes === 'chico' ? PNG_CHICO : PNG_GRANDE, mimeType: 'image/png' };
    },
  };
}

const depsDe = (image, dir) => ({ llm: {}, image, tts: {}, storageDir: dir });

test('un proveedor sin recommendedConcurrency igual genera las imagenes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conc-'));
  const story = historia();
  const image = proveedor();

  await generateImages(depsDe(image, dir), story, {});

  assert.equal(image.llamadas(), 3, 'las tres imagenes se pidieron');
  for (const s of story.scenes) {
    assert.equal(s.variants.length, 1, `el plano ${s.index} no tiene imagen`);
  }
});

test('concurrencia declarada se respeta y no duplica trabajo', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conc-'));
  const story = historia();
  const image = proveedor({ concurrency: 2 });

  await generateImages(depsDe(image, dir), story, {});

  assert.equal(image.llamadas(), 3, 'ni una llamada de mas con dos trabajadores');
  assert.ok(story.scenes.every((s) => s.variants.length === 1));
});

test('una concurrencia absurda se recorta al numero de planos', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conc-'));
  const story = historia();
  const image = proveedor({ concurrency: 999 });

  await generateImages(depsDe(image, dir), story, {});

  assert.equal(image.llamadas(), 3);
});

test('cada plano recibe exactamente una imagen y queda generado', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conc-'));
  const story = historia();
  const image = proveedor();
  const eventos = [];

  await generateImages(
    { ...depsDe(image, dir), onProgress: (p) => eventos.push(p) },
    story,
    {},
  );

  // Invariante que el bucle de trabajadores debe cumplir siempre: sin esto,
  // un plano puede quedarse sin tomar y solo se nota al renderizar.
  for (const s of story.scenes) {
    assert.equal(s.variants.length, 1, `plano ${s.index}: ${s.variants.length} variantes`);
    assert.equal(s.status, 'generated', `plano ${s.index}: estado ${s.status}`);
  }

  const fin = eventos.filter((e) => e.stage === 'images' && e.status === 'done');
  assert.equal(fin.length, 1, 'la etapa se anuncia completada exactamente una vez');
  assert.equal(fin[0].completed, story.scenes.length, 'y con el total real de planos');
});

test('con dos variantes salen dos imagenes por plano', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conc-'));
  const story = historia();
  const image = proveedor({ concurrency: 2 });

  await generateImages(depsDe(image, dir), story, { variants: 2 });

  assert.equal(image.llamadas(), 6, 'tres planos por dos variantes');
  for (const s of story.scenes) assert.equal(s.variants.length, 2);
});

test('un plano ya generado y presente en disco no se vuelve a pedir', async () => {
  // El modo $0 obliga a esto. Una historia de trece planos se detiene a mitad
  // porque el proveedor gratuito falla, y sin reanudar el segundo intento
  // vuelve a pagar las cuatro fichas de personaje y los siete planos que ya
  // estaban bien, para caer otra vez en el mismo punto.
  const dir = mkdtempSync(path.join(tmpdir(), 'conc-resume-'));
  const story = historia();

  // Primera pasada: se corta cuando ya hay al menos un plano COMPLETO, como
  // si el proceso hubiera muerto en mitad. El contador de `shouldStop` va dos
  // por plano (uno al empezar el plano y otro antes de cada variante), asi que
  // cortar en 5 deja el primero entero y el segundo a medias.
  const primero = proveedor({ concurrency: 1 });
  let paradas = 0;
  await generateImages({
    ...depsDe(primero, dir),
    shouldStop: () => { if (++paradas >= 5) throw new Error('se murio a mitad'); },
  }, story, {}).catch(() => undefined);

  const completos = story.scenes.filter((s) => s.variants.length === 1).length;
  assert.ok(completos >= 1, `la primera pasada dejo ${completos} planos completos`);

  // Segunda pasada: solo debe pedir los que falten.
  const antes = story.scenes.filter((s) => s.variants.length === 1).map((s) => s.variants[0]);
  const segundo = proveedor({ concurrency: 1 });
  await generateImages(depsDe(segundo, dir), story, {});

  assert.equal(segundo.llamadas(), 3 - completos,
    'solo pide los planos que faltaban, no vuelve a pagar los listos');
  assert.deepEqual(
    story.scenes.filter((s) => s.variants.length === 1).map((s) => s.variants[0]).slice(0, antes.length),
    antes,
    'los planos ya listos siguen siendo los mismos archivos',
  );
  assert.ok(story.scenes.every((s) => s.variants.length === 1));
});

test('una imagen de 0 bytes no cuenta como lista', async () => {
  // Marcar un plano como generado y luego vaciar el archivo es peor que
  // repetirlo: el fallo aparece tres etapas mas tarde, en el render.
  const dir = mkdtempSync(path.join(tmpdir(), 'conc-vacia-'));
  const story = historia();
  const image = proveedor({ concurrency: 1 });

  await generateImages(depsDe(image, dir), story, {});

  const archivo = story.scenes[0].variants[0];
  writeFileSync(archivo, '');

  const segunda = proveedor({ concurrency: 1 });
  await generateImages(depsDe(segunda, dir), story, {});

  assert.equal(segunda.llamadas(), 1, 'regenera solo el plano vacio, no los otros dos');
  assert.ok(statSync(archivo).size > 0, 'el archivo quedo repuesto');
});

test('con resume:false se rehace todo aunque este en disco', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conc-forzar-'));
  const story = historia();

  await generateImages(depsDe(proveedor({ concurrency: 1 }), dir), story, {});
  const forzada = proveedor({ concurrency: 1 });
  await generateImages(depsDe(forzada, dir), story, { resume: false });

  assert.equal(forzada.llamadas(), 3, 'regenerar a proposito tiene que rehacerlo todo');
});

test('cancelar a mitad detiene sin marcar la etapa como completada', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conc-'));
  const story = historia();
  const eventos = [];
  let llamadas = 0;

  await assert.rejects(() =>
    generateImages({
      ...depsDe({ ...proveedor(), async generate() { llamadas++; return { base64: 'iVBORw0KGgo=', mimeType: 'image/png' }; } }, dir),
      onProgress: (p) => eventos.push(p),
      shouldStop: () => { if (llamadas >= 2) throw new Error('cancelado'); },
    }, story, {}),
  );

  assert.ok(llamadas < 6, `se pararon en ${llamadas} llamadas de 3 posibles`);
  assert.equal(
    eventos.some((e) => e.stage === 'images' && e.status === 'done'),
    false,
    'una etapa cancelada no se marca como completada',
  );
});
