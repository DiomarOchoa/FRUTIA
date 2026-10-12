/**
 * Cancelacion de trabajos.
 *
 * Sin esto, un envio equivocado deja al usuario esperando minutos sin salida.
 * Estos tests fijan que cancelar funciona tanto si el trabajo esta en la cola
 * como si ya empezo a correr, y que no rompe los demás.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { JobQueue } from '../../../apps/api/dist/jobs.js';

const tick = () => new Promise((r) => setTimeout(r, 10));

test('cancelar un trabajo en cola lo quita de la lista de espera', async () => {
  const queue = new JobQueue(1);
  let liberado;
  const bloquea = new Promise((r) => { liberado = r; });

  const primero = queue.enqueue('draft', 'a', async () => { await bloquea; });
  const segundo = queue.enqueue('draft', 'b', async () => {});

  await tick();
  assert.equal(primero.status, 'running');
  assert.equal(segundo.status, 'queued');

  assert.equal(queue.cancel(segundo.id), true);
  assert.equal(queue.get(segundo.id)?.status, 'failed');
  assert.equal(queue.get(segundo.id)?.error, 'Cancelado por el usuario.');

  liberado();
  await tick();

  // El trabajo ya terminado sigue intacto.
  assert.equal(queue.get(primero.id)?.status, 'done');
});

test('cancelar un trabajo en ejecucion lanza la senal de parada', async () => {
  const queue = new JobQueue(1);
  let cancelado = false;

  const job = queue.enqueue('draft', 'a', async () => {
    // El pipeline consulta la senal entre etapas, como hace shouldStop.
    await tick();
    queue.bindCancel(job.id, () => { cancelado = true; });
    await tick();
    if (cancelado) throw new Error('Cancelado por el usuario.');
  });

  await tick();
  queue.bindCancel(job.id, () => { cancelado = true; });
  queue.cancel(job.id);
  await tick();

  assert.equal(cancelado, true, 'la senal debe llegar al trabajo en curso');
  assert.equal(queue.get(job.id)?.status, 'failed');
});

test('cancelar un trabajo ya terminado no cambia su estado', async () => {
  const queue = new JobQueue(2);
  const job = queue.enqueue('draft', 'a', async () => {});
  await tick();
  await tick();

  assert.equal(queue.get(job.id)?.status, 'done');
  assert.equal(queue.cancel(job.id), false);
  assert.equal(queue.get(job.id)?.status, 'done', 'un trabajo correcto no se toca');
});

test('cancelar un trabajo inexistente devuelve false', () => {
  const queue = new JobQueue(1);
  assert.equal(queue.cancel('no-existe'), false);
});

test('un trabajo fallido libera la concurrencia para el siguiente', async () => {
  const queue = new JobQueue(1);
  const a = queue.enqueue('draft', 'a', async () => { await tick(); });
  const b = queue.enqueue('draft', 'b', async () => {});

  await tick();
  queue.cancel(a.id);
  await tick();
  await tick();

  assert.equal(queue.get(b.id)?.status, 'done', 'el segundo trabajo debe ejecutarse igual');
});

test('get nunca expone los internos del trabajo', async () => {
  const queue = new JobQueue(1);
  const job = queue.enqueue('draft', 'a', async () => {});
  await tick();

  const visto = queue.get(job.id);
  assert.ok(visto);
  assert.equal('handler' in visto, false);
  assert.equal('cancel' in visto, false);
});