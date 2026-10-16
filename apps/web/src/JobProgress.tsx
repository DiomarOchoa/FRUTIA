import { useEffect, useRef, useState } from 'react';
import { api, artifactUrl, ApiError, type Job, type StageProgress } from './api';

const STAGE_LABELS: Record<string, string> = {
  script: 'Guion',
  images: 'Imagenes',
  voice: 'Voz',
  subtitles: 'Subtitulos',
  compose: 'Render',
  export: 'Export',
};

/**
 * Sigue un trabajo por sondeo.
 *
 * Se usa polling y no SSE a proposito: el pipeline son unas 13 llamadas a la
 * API y el sondeo cada 1.5s es suficiente y no mantiene conexiones abiertas,
 * que en un despliegue de una sola instancia es una complicacion gratis.
 */
export function useJob(jobId: string | null): Job | null {
  const [job, setJob] = useState<Job | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!jobId) { setJob(null); return; }

    let cancelled = false;

    const tick = async () => {
      try {
        const current = await api.getJob(jobId);
        if (cancelled) return;
        setJob(current);
        if (current.status === 'queued' || current.status === 'running') {
          timer.current = window.setTimeout(tick, 1500);
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) { setJob(null); return; }
        timer.current = window.setTimeout(tick, 3000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [jobId]);

  return job;
}

/** Calcula el porcentaje global a partir del progreso por etapa. */
export function overallPercent(job: Job | null): number {
  if (!job || job.progress.length === 0) return 0;
  const sum = job.progress.reduce((acc, s) => acc + (s.total > 0 ? s.completed / s.total : 0), 0);
  return Math.round((sum / job.progress.length) * 100);
}

export function JobProgress({
  job,
  onCancel,
}: {
  job: Job | null;
  onCancel?: () => void;
}) {
  if (!job) return null;

  if (job.status === 'failed') {
    return <div className="alert alert-error">{job.error ?? 'El trabajo fallo.'}</div>;
  }

  if (job.status === 'done') {
    return <div className="alert alert-info">Listo. {job.outputPath ? 'El video esta en la lista.' : ''}</div>;
  }

  const percent = overallPercent(job);
  const activeStage = job.progress.find((stage) => stage.status === 'running');

  return (
    <div className="card-inset stack" style={{ gap: 12 }}>
      <div className="row-between">
        <div className="row">
          <span className="spinner" />
          <strong className="small">
            {job.status === 'queued' ? 'En cola' : job.kind === 'draft' ? 'Generando frutinovela' : 'Renderizando video'}
          </strong>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="mono dim">{percent}%</span>
          {onCancel && (
            <button className="btn btn-sm" onClick={onCancel}>
              Cancelar
            </button>
          )}
        </div>
      </div>

      <div className="bar"><div className="bar-fill" style={{ width: `${percent}%` }} /></div>

      {activeStage?.message && <p className="progress-note">{activeStage.message}</p>}

      {job.progress.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {job.progress.map((s: StageProgress) => (
            <span key={s.stage} className="chip">
              {s.total > 0 && `${s.completed}/${s.total} · `}
              {STAGE_LABELS[s.stage] ?? s.stage}
            </span>
          ))}
        </div>
      )}

      <p className="tiny faint">
        Frutia trabaja en segundo plano. En modo local, el tiempo de las imágenes depende de la velocidad del equipo.
      </p>
    </div>
  );
}
