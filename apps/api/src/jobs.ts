/**
 * Cola de trabajos en memoria.
 *
 * El pipeline tarda minutos (cada imagen son 10-30s y una historia son ~13
 * llamadas). Por eso la generacion es asincrona y la API solo encola. No se usa
 * Redis ni BullMQ a proposito: con un solo worker, una cola en proceso con limite
 * de concurrencia hace lo mismo y cuesta cero. Cuando haga falta escalar, esta
 * clase es la unica que hay que sustituir por BullMQ.
 *
 * El limite de concurrencia existe por una razon tecnica, no de estilo: las APIs
 * gratuitas aplican rate limits por minuto. Lanzar diez generaciones de imagen a
 * la vez produce errores 429; con concurrencia baja el pipeline es lento pero
 * termina.
 */

import { randomUUID } from 'node:crypto';
import type { StageProgress } from '@frutia/core';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  storyId?: string;
  kind: 'draft' | 'compose' | 'regenerate';
  status: JobStatus;
  progress: StageProgress[];
  outputPath?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

/**
 * Ejecuta un trabajo. Si resuelve con una ruta, se guarda en `outputPath` del
 * trabajo (por ejemplo el MP4 final); cualquier otro valor de retorno se ignora.
 */
export type JobHandler = (job: Job, emit: (p: StageProgress) => void) => Promise<string | void>;

export class JobQueue {
  /** El ejecutor viaja con el trabajo: evita el apareamiento tardio. */
  private readonly jobs = new Map<string, Job & { handler?: JobHandler; cancel?: () => void }>();
  private readonly pending: string[] = [];
  private running = 0;

  constructor(
    private readonly concurrency: number,
    private readonly maxRetained: number = 100,
  ) {}

  enqueue(kind: Job['kind'], storyId: string | undefined, handler: JobHandler): Job {
    const job: Job & { handler?: JobHandler; cancel?: () => void } = {
      id: randomUUID(),
      storyId,
      kind,
      status: 'queued',
      progress: [],
      createdAt: new Date().toISOString(),
      handler,
    };

    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.prune();

    // `queueMicrotask` garantiza que `enqueue` devuelve antes de que empiece
    // el trabajo: el handler ya quedo registrado arriba, asi que no hay carrera.
    queueMicrotask(() => this.drain());
    return job;
  }

  /**
   * Cancela un trabajo, este en cola o en ejecucion.
   *
   * Sin esto, un envio equivocado deja al usuario esperando minutos sin
   * salida. La cancelacion es cooperativa: el trabajo en curso comprueba la
   * senal entre etapas, porque abortar un stream de bytes a mitad dejaria
   * archivos a medias en disco.
   */
  cancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    if (entry.status === 'done' || entry.status === 'failed') return false;

    entry.status = 'failed';
    entry.error = 'Cancelado por el usuario.';
    entry.finishedAt = new Date().toISOString();

    // Si aun estaba en la cola, sale de ella.
    const pos = this.pending.indexOf(jobId);
    if (pos !== -1) this.pending.splice(pos, 1);

    // Si estaba corriendo, la senal detiene el pipeline en la siguiente etapa.
    entry.cancel?.();
    return true;
  }

  get(jobId: string): Job | undefined {
    const entry = this.jobs.get(jobId);
    if (!entry) return undefined;
    const { handler: _h, cancel: _c, ...job } = entry;
    return job as Job;
  }

  list(): Job[] {
    return [...this.jobs.values()]
      .map(({ handler: _handler, ...job }) => job as Job)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Ejecuta trabajo pendiente respetando el limite de concurrencia. */
  private drain(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift();
      if (!jobId) break;

      const entry = this.jobs.get(jobId);
      if (!entry?.handler) continue;

      const handler = entry.handler;
      delete entry.handler;

      this.running++;
      entry.status = 'running';

      const emit = (p: StageProgress) => {
        const existing = entry.progress.find((s) => s.stage === p.stage);
        if (existing) Object.assign(existing, p);
        else entry.progress.push(p);
      };

      handler(entry as Job, emit)
        .then((outputPath) => {
          entry.status = 'done';
          if (outputPath) entry.outputPath = outputPath;
        })
        .catch((error: unknown) => {
          entry.status = 'failed';
          entry.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          entry.finishedAt = new Date().toISOString();
          this.running--;
          this.drain();
        });
    }
  }

  /** Registra como parar un trabajo en ejecucion. */
  bindCancel(jobId: string, onCancel: () => void): void {
    const entry = this.jobs.get(jobId);
    if (entry) entry.cancel = onCancel;
  }

  /** Descarta los trabajos terminados mas antiguos para no crecer sin limite. */
  private prune(): void {
    if (this.jobs.size <= this.maxRetained) return;
    const excess = this.list()
      .filter((j) => j.status === 'done' || j.status === 'failed')
      .slice(this.maxRetained);
    for (const job of excess) this.jobs.delete(job.id);
  }
}