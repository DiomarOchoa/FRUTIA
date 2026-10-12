/**
 * Prueba de los endpoints de edicion contra el servidor real.
 *
 * Levanta el servidor con una clave falsa (no se llama a ninguna IA) y verifica
 * el contrato HTTP: reordenar, duplicar, borrar, elegir variante y los errores.
 * Comprueba tambien la validacion que protege el estado de la historia.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const PORT = 4123;
const BASE = `http://localhost:${PORT}`;
const STORAGE = mkdtempSync(path.join(tmpdir(), 'api-edit-'));

/** Historia minima escrita a mano, sin pasar por el LLM. */
const STORY = {
  id: 'test-story',
  title: 'Historia de prueba',
  premise: 'Una prueba',
  visualStyleId: 'stopmotion',
  visualStyle: 'stop motion',
  tone: 'drama',
  characters: [
    { id: 'c1', name: 'Fresa', species: 'fresa', archetype: 'hero', visualDescription: 'roja', personality: 'x', voiceTone: 'f' },
  ],
  scenes: [
    { id: 's1', index: 1, role: 'hook', narration: 'Uno', shotDescription: 'A', characterIds: ['c1'], targetDuration: 4, variants: ['/a/1.png'], activeVariant: 0, attempts: 1, status: 'generated' },
    { id: 's2', index: 2, role: 'setup', narration: 'Dos', shotDescription: 'B', characterIds: ['c1'], targetDuration: 8, variants: ['/a/2.png', '/a/2b.png'], activeVariant: 0, attempts: 2, status: 'generated' },
    { id: 's3', index: 3, role: 'turn', narration: 'Tres', shotDescription: 'C', characterIds: [], targetDuration: 8, variants: [], activeVariant: 0, attempts: 0, status: 'draft' },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

mkdirSync(STORAGE, { recursive: true });
writeFileSync(path.join(STORAGE, 'test-story.json'), JSON.stringify(STORY, null, 2));

// Se invoca el binario de tsx directamente en vez de `npx`: en Windows `npx`
// es un .cmd que obliga a `shell: true`, y eso ensucia la salida con un
// aviso de depreciacion.
const TSX = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

const server = spawn(process.execPath, [TSX, 'apps/api/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), STORAGE_DIR: STORAGE, GEMINI_API_KEY: 'clave-falsa' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.on('error', (err) => console.error('No se pudo arrancar el servidor:', err.message));

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

async function api(route, init) {
  const res = await fetch(`${BASE}${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// Espera a que el servidor responda.
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (res.ok) break;
  } catch { /* aun arrancando */ }
  await new Promise((r) => setTimeout(r, 500));
}

try {
  console.log('\nEndpoints de edicion:');

  const health = await api('/api/health');
  check('health responde', health.status === 200);

  // ── Reordenar ────────────────────────────────────────────────
  const reorder = await api('/api/stories/test-story/scenes/reorder', {
    method: 'POST',
    body: JSON.stringify({ sceneIds: ['s3', 's1', 's2'] }),
  });
  check('reordenar devuelve 200', reorder.status === 200, `status ${reorder.status}`);
  check('reordenar aplica el orden', reorder.body?.scenes?.[0]?.id === 's3');
  check('reordenar reindexa', JSON.stringify(reorder.body?.scenes?.map((s) => s.index)) === '[1,2,3]');

  const badReorder = await api('/api/stories/test-story/scenes/reorder', {
    method: 'POST',
    body: JSON.stringify({ sceneIds: ['s1', 's1', 's2'] }),
  });
  check('reordenar rechaza ids repetidos', badReorder.status >= 400, `status ${badReorder.status}`);

  // Tras el rechazo, la historia sigue como estaba.
  const afterBad = await api('/api/stories/test-story');
  check('reordenar rechazado no corrompe la historia', afterBad.body?.scenes?.length === 3);

  // ── Duplicar ─────────────────────────────────────────────────
  const dup = await api('/api/stories/test-story/scenes/s1/duplicate', { method: 'POST' });
  check('duplicar devuelve 200', dup.status === 200, `status ${dup.status}`);
  check('duplicar anade un plano', dup.body?.scenes?.length === 4);
  check('duplicar reindexa', JSON.stringify(dup.body?.scenes?.map((s) => s.index)) === '[1,2,3,4]');

  // Tras el reorden el orden es s3, s1, s2; el duplicado va justo detras de s1.
  const ids = dup.body?.scenes?.map((s) => s.id) ?? [];
  const s1Pos = ids.indexOf('s1');
  const copy = dup.body?.scenes?.[s1Pos + 1];
  check('duplicar inserta detras del original', s1Pos !== -1 && copy?.id?.startsWith('s1-'), `pos ${s1Pos}`);
  check('duplicar da id nuevo', copy?.id !== 's1');
  check('duplicar copia la narracion', copy?.narration === 'Uno');
  check('duplicar no hereda la aprobacion', copy?.status === 'generated');

  // ── Variantes ────────────────────────────────────────────────
  const pickVariant = await api('/api/stories/test-story/scenes/s2', {
    method: 'PATCH',
    body: JSON.stringify({ activeVariant: 1 }),
  });
  check('elegir variante devuelve 200', pickVariant.status === 200);
  check('elegir variante guarda el indice', pickVariant.body?.scenes?.[3]?.activeVariant === 1
    || pickVariant.body?.scenes?.some((s) => s.activeVariant === 1));

  const badVariant = await api('/api/stories/test-story/scenes/s3', {
    method: 'PATCH',
    body: JSON.stringify({ activeVariant: 7 }),
  });
  check('elegir variante fuera de rango da 400', badVariant.status === 400, `status ${badVariant.status}`);

  const badStatus = await api('/api/stories/test-story/scenes/s1', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'inventado' }),
  });
  check('estado invalido da 400', badStatus.status === 400, `status ${badStatus.status}`);

  // ── Migracion ────────────────────────────────────────────────
  // Se escribe una historia con el formato antiguo (imagePath en vez de variants).
  writeFileSync(path.join(STORAGE, 'legacy.json'), JSON.stringify({
    ...STORY,
    id: 'legacy',
    scenes: [{
      id: 's1', index: 1, role: 'hook', narration: 'Viejo', shotDescription: 'A',
      characterIds: [], targetDuration: 4, imagePath: '/legacy/1.png',
      status: 'generated',
    }],
  }));

  const legacy = await api('/api/stories/legacy');
  check('migra imagePath a variants', legacy.body?.scenes?.[0]?.variants?.[0] === '/legacy/1.png');
  check('la migracion elimina imagePath', legacy.body?.scenes?.[0]?.imagePath === undefined);
  check('la migracion pone activeVariant', legacy.body?.scenes?.[0]?.activeVariant === 0);

  // ── Borrar ───────────────────────────────────────────────────
  const del = await api('/api/stories/test-story/scenes/s3', { method: 'DELETE' });
  check('borrar devuelve 200', del.status === 200, `status ${del.status}`);
  check('borrar quita el plano', del.body?.scenes?.length === 3);

  const delMissing = await api('/api/stories/test-story/scenes/no-existe', { method: 'DELETE' });
  check('borrar un plano inexistente da 404', delMissing.status === 404, `status ${delMissing.status}`);

  // ── Errores generales ────────────────────────────────────────
  const noStory = await api('/api/stories/no-existe');
  check('historia inexistente da 404', noStory.status === 404);

  const regenNoKey = await fetch(`${BASE}/api/stories/test-story/scenes/s1/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variants: 2 }),
  });
  // Con clave falsa el pipeline falla al llamar a la IA, pero el endpoint debe
  // encolar el trabajo y devolver 202, no reventar.
  check('regenerar devuelve 202 al encolar', regenNoKey.status === 202, `status ${regenNoKey.status}`);
} finally {
  server.kill();
}

console.log(`\n${passed} ok, ${failed} fallos`);
process.exit(failed === 0 ? 0 : 1);