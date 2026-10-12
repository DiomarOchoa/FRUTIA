import { useEffect, useState, type FormEvent } from 'react';
import type { Scene, Story } from '@frutia/core';
import { api, artifactUrl, describeError, type Idea, type StyleSpec } from './api';
import { JobProgress, useJob } from './JobProgress';

const SCENE_ROLE_LABELS: Record<string, string> = {
  hook: 'Gancho',
  setup: 'Presentacion',
  conflict: 'Conflicto',
  escalation: 'Tension',
  turn: 'Giro',
  cliffhanger: 'Final abierto',
  cta: 'Llamada',
};

const STATUS_LABELS: Record<Scene['status'], string> = {
  draft: 'Borrador',
  generated: 'Generado',
  approved: 'Aprobado',
  rejected: 'Descartado',
};

export interface StoryEditorProps {
  story: Story;
  onClose: () => void;
  onChanged: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor de un plano
// ─────────────────────────────────────────────────────────────────────────────

function SceneCard({
  story,
  scene,
  onPatch,
  onRegenerate,
  onDuplicate,
  onDelete,
  onMove,
  busy,
  regenerating,
}: {
  story: Story;
  scene: Scene;
  onPatch: (patch: Partial<Scene>) => Promise<void>;
  onRegenerate: (opts: { variants: number; regenerateVoice: boolean }) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  busy: boolean;
  regenerating: boolean;
}) {
  const [narration, setNarration] = useState(scene.narration);
  const [dirty, setDirty] = useState(false);
  const [showVariants, setShowVariants] = useState(false);

  // Si el pipeline regenera el plano desde fuera, lo reflejamos sin pisar
  // lo que el usuario esta escribiendo en este momento.
  useEffect(() => {
    if (!dirty) setNarration(scene.narration);
  }, [scene.narration, dirty]);

  const active = scene.variants[scene.activeVariant];
  const image = artifactUrl(active);
  const audio = artifactUrl(scene.audioPath);
  const cast = scene.characterIds
    .map((id) => story.characters.find((c) => c.id === id)?.name)
    .filter(Boolean)
    .join(', ');

  const disabled = busy || regenerating;
  const isFirst = scene.index === 1;
  const isLast = scene.index === story.scenes.length;

  return (
    <div className={`scene scene-${scene.status}`}>
      <div className="scene-thumb">
        {image ? <img src={image} alt={`Plano ${scene.index}`} loading="lazy" /> : <span>sin imagen</span>}
        {regenerating && <div className="thumb-spinner" />}
      </div>

      <div className="scene-body">
        <div className="row wrap" style={{ gap: 7 }}>
          <span className="label">Plano {scene.index}</span>
          <span className="chip">{SCENE_ROLE_LABELS[scene.role] ?? scene.role}</span>
          <span className="chip">{scene.targetDuration.toFixed(1)}s</span>
          <span className={`badge badge-${scene.status}`}>{STATUS_LABELS[scene.status]}</span>
          {scene.attempts > 1 && <span className="chip">{scene.attempts} tomas</span>}
          {cast && <span className="chip">{cast}</span>}
        </div>

        <textarea
          value={narration}
          onChange={(e) => { setNarration(e.target.value); setDirty(true); }}
          onBlur={async () => {
            if (!dirty || narration === scene.narration) { setDirty(false); return; }
            await onPatch({ narration });
            setDirty(false);
          }}
          disabled={busy}
          rows={2}
          aria-label={`Narracion del plano ${scene.index}`}
        />

        {/* Candidatas: solo aparecen si el plano fue generado mas de una vez. */}
        {scene.variants.length > 1 && (
          <div className="variants">
            {showVariants
              ? scene.variants.map((path, i) => {
                  const url = artifactUrl(path);
                  return url ? (
                    <button
                      key={i}
                      className={`variant ${i === scene.activeVariant ? 'variant-active' : ''}`}
                      onClick={() => onPatch({ activeVariant: i })}
                      disabled={busy}
                      aria-label={`Elegir la toma ${i + 1}`}
                      title={`Toma ${i + 1}`}
                    >
                      <img src={url} alt="" loading="lazy" />
                    </button>
                  ) : null;
                })
              : null}
            <button
              className="btn btn-sm"
              onClick={() => setShowVariants((v) => !v)}
              disabled={busy}
            >
              {showVariants ? 'Ocultar tomas' : `${scene.variants.length} tomas`}
            </button>
          </div>
        )}

        <div className="row-between wrap" style={{ gap: 10 }}>
          <span className="tiny faint">{scene.shotDescription}</span>
          {audio && <audio controls src={audio} preload="none" style={{ maxWidth: 260 }} />}
        </div>
      </div>

      <div className="scene-actions">
        <button
          className="btn btn-sm btn-ok"
          disabled={disabled || scene.status === 'approved'}
          onClick={() => onPatch({ status: 'approved' })}
        >
          Aprobar
        </button>

        <div className="row" style={{ gap: 5 }}>
          <button
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => onRegenerate({ variants: 1, regenerateVoice: false })}
            title="Genera otra version de este plano"
          >
            {regenerating ? '...' : 'Regenerar'}
          </button>
          <button
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => onRegenerate({ variants: 3, regenerateVoice: false })}
            title="Genera 3 candidatas y elige la mejor"
          >
            x3
          </button>
        </div>

        <div className="row" style={{ gap: 5 }}>
          <button className="btn btn-sm" disabled={disabled || isFirst} onClick={() => onMove(-1)} title="Subir">&#8593;</button>
          <button className="btn btn-sm" disabled={disabled || isLast} onClick={() => onMove(1)} title="Bajar">&#8595;</button>
          <button className="btn btn-sm" disabled={disabled} onClick={onDuplicate} title="Duplicar plano">Duplicar</button>
          <button className="btn btn-sm" disabled={disabled || story.scenes.length <= 1} onClick={onDelete} title="Borrar plano">Borrar</button>
        </div>

        <button
          className="btn btn-sm"
          disabled={disabled || scene.status === 'rejected'}
          onClick={() => onPatch({ status: 'rejected' })}
        >
          Descartar
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor de historia
// ─────────────────────────────────────────────────────────────────────────────

export function StoryEditor({ story, onClose, onChanged }: StoryEditorProps) {
  const [current, setCurrent] = useState(story);
  const [busyScene, setBusyScene] = useState<string | null>(null);
  const [regenJobId, setRegenJobId] = useState<string | null>(null);
  const [composeJobId, setComposeJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const composeJob = useJob(composeJobId);
  const regenJob = useJob(regenJobId);

  useEffect(() => setCurrent(story), [story]);

  // Cuando termina una regeneracion recargamos la historia para traer las
  // candidatas nuevas sin tener que enlazar cada boton por separado.
  useEffect(() => {
    if (regenJob?.status === 'done') {
      const id = current.id;
      setRegenJobId(null);
      void api.getStory(id).then(setCurrent).catch(() => undefined);
      onChanged();
    }
  }, [regenJob?.status]);

  const fail = (err: unknown, fallback: string) =>
    setError(describeError(err) || fallback);

  const patchScene = async (sceneId: string, patch: Partial<Scene>) => {
    setBusyScene(sceneId);
    setError(null);
    try {
      setCurrent(await api.patchScene(current.id, sceneId, patch));
      onChanged();
    } catch (err) {
      fail(err, 'No se pudo guardar el plano.');
    } finally {
      setBusyScene(null);
    }
  };

  const regenerate = async (sceneId: string, opts: { variants: number; regenerateVoice: boolean }) => {
    setError(null);
    try {
      const { jobId } = await api.regenerateScene(current.id, sceneId, opts);
      setRegenJobId(jobId);
    } catch (err) {
      fail(err, 'No se pudo iniciar la regeneracion.');
    }
  };

  /** Reordena moviendo un plano una posicion y persiste el orden completo. */
  const move = async (sceneId: string, direction: -1 | 1) => {
    const ids = current.scenes.map((s) => s.id);
    const from = ids.indexOf(sceneId);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= ids.length) return;

    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    setError(null);
    try {
      setCurrent(await api.reorderScenes(current.id, next));
      onChanged();
    } catch (err) {
      fail(err, 'No se pudo reordenar.');
    }
  };

  const duplicate = async (sceneId: string) => {
    setError(null);
    try {
      setCurrent(await api.duplicateScene(current.id, sceneId));
      onChanged();
    } catch (err) {
      fail(err, 'No se pudo duplicar el plano.');
    }
  };

  const remove = async (sceneId: string) => {
    if (!confirm('Borrar este plano?')) return;
    setError(null);
    try {
      setCurrent(await api.deleteScene(current.id, sceneId));
      onChanged();
    } catch (err) {
      fail(err, 'No se pudo borrar el plano.');
    }
  };

  const approveAll = async () => {
    setError(null);
    try {
      for (const scene of current.scenes) {
        if (scene.status !== 'approved') await api.patchScene(current.id, scene.id, { status: 'approved' });
      }
      setCurrent(await api.getStory(current.id));
      onChanged();
    } catch (err) {
      fail(err, 'No se pudieron aprobar los planos.');
    }
  };

  const compose = async () => {
    setError(null);
    try {
      setComposeJobId((await api.compose(current.id)).jobId);
    } catch (err) {
      fail(err, 'No se pudo iniciar el render.');
    }
  };

  const approved = current.scenes.filter((s) => s.status === 'approved');
  const totalDuration = approved.reduce((acc, s) => acc + s.targetDuration, 0);
  const videoReady = composeJob?.status === 'done' && approved.length > 0;

  // Cuantos segundos faltan para llegar al minuto que paga TikTok.
  const faltan = Math.max(0, 60 - totalDuration);
  // El plano mas largo que se puede duplicar: el mas efficient para alargar.
  const mejorParaDuplicar = approved.reduce<Scene | null>(
    (mejor, s) => (!mejor || s.targetDuration > mejor.targetDuration ? s : mejor),
    null,
  );

  return (
    <div className="stack">
      {/* Cabecera */}
      <div className="row-between wrap">
        <div>
          <div className="row">
            <button className="btn btn-sm" onClick={onClose}>Volver</button>
            <h1>{current.title}</h1>
          </div>
          <p className="dim small" style={{ margin: '6px 0 0' }}>{current.premise}</p>
        </div>

        <div className="row wrap">
          <span className={`badge ${totalDuration >= 60 ? 'badge-approved' : 'badge-generated'}`}>
            {totalDuration.toFixed(0)}s · {approved.length}/{current.scenes.length} aprobados
          </span>
          <button
            className="btn btn-sm"
            disabled={approved.length !== current.scenes.length}
            onClick={approveAll}
          >
            Aprobar todo
          </button>
          <button className="btn btn-primary btn-sm" disabled={approved.length === 0} onClick={compose}>
            Renderizar video
          </button>
        </div>
      </div>

      {totalDuration > 0 && faltan > 0 && (
        <div className="alert alert-error">
          <strong>Te faltan {faltan.toFixed(0)} segundos para los 60.</strong> TikTok solo
          paga los videos de un minuto o mas, asi que este no generara ingresos.
          <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
            {mejorParaDuplicar && approved.length > 0 && (
              <button
                className="btn btn-sm"
                onClick={() => duplicate(mejorParaDuplicar.id)}
                title="Copia el plano mas largo: alarga el video sin gastar API"
              >
                Duplicar el plano mas largo (+{mejorParaDuplicar.targetDuration.toFixed(0)}s)
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={() => setCurrent((c) => ({
                ...c,
                scenes: c.scenes.map((s) => (
                  s.status === 'approved' ? { ...s, targetDuration: s.targetDuration * 1.2 } : s
                )),
              }))}
              title="Estira los tiempos un 20%. Ajusta el audio al vuelo; no consume API."
            >
              Estirar tiempos +20%
            </button>
          </div>
          <p className="tiny faint" style={{ margin: '8px 0 0' }}>
            Duplicar y estirar no gastan cuota: reutilizan imagen y audio existentes.
            Estirar puede desincronizar el subtitulo; si notas desajuste, renderiza y comprueba.
          </p>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {regenJob && <JobProgress job={regenJob} />}
      <JobProgress job={composeJob} />

      {videoReady && (
        <div className="card">
          <div className="label" style={{ marginBottom: 12 }}>Video final</div>
          <video controls src={`/api/stories/${current.id}/video`} />
          <div className="row" style={{ marginTop: 14 }}>
            <a className="btn btn-primary btn-sm" href={`/api/stories/${current.id}/video`} download>
              Descargar MP4
            </a>
          </div>
        </div>
      )}

      {/* Reparto */}
      {current.characters.length > 0 && (
        <div className="card">
          <div className="label" style={{ marginBottom: 12 }}>Reparto</div>
          <div className="grid-cast">
            {current.characters.map((c) => {
              const ref = artifactUrl(c.referenceImagePath);
              return (
                <div className="cast-card" key={c.id}>
                  <div className="cast-img">
                    {ref && <img src={ref} alt={c.name} loading="lazy" />}
                  </div>
                  <div>
                    <div className="small" style={{ fontWeight: 650 }}>{c.name}</div>
                    <div className="tiny faint">{c.species} · {c.archetype}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Planos */}
      <div className="stack" style={{ gap: 10 }}>
        <div className="label">Planos · revisa y aprueba antes de exportar</div>
        <div className="scenes">
          {current.scenes.map((scene) => (
            <SceneCard
              key={scene.id}
              story={current}
              scene={scene}
              busy={busyScene === scene.id}
              regenerating={regenJob?.status === 'running' || regenJob?.status === 'queued'}
              onPatch={(patch) => patchScene(scene.id, patch)}
              onRegenerate={(opts) => regenerate(scene.id, opts)}
              onDuplicate={() => duplicate(scene.id)}
              onDelete={() => remove(scene.id)}
              onMove={(direction) => move(scene.id, direction)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Formulario de nueva historia
// ─────────────────────────────────────────────────────────────────────────────

export function NewStoryForm({
  styles,
  onCreated,
}: {
  styles: StyleSpec[];
  onCreated: (jobId: string) => void;
}) {
  const [topic, setTopic] = useState('');
  const [tone, setTone] = useState('melodramatico con humor negro');
  const [styleId, setStyleId] = useState(styles[0]?.id ?? 'stopmotion');
  const [sceneCount, setSceneCount] = useState(8);
  const [variants, setVariants] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [ideaIndex, setIdeaIndex] = useState<number | undefined>();
  const [restantes, setRestantes] = useState<number | null>(null);
  const [loadingIdeas, setLoadingIdeas] = useState(false);

  /**
   * Pide propuestas nuevas.
   *
   * El historial se descuenta en el servidor, asi que estas ideas nunca
   * coinciden con una ya generada. Al elegir una se guarda su indice: al
   * publicar se marcara como usada y dejara de ofrecerse.
   */
  const loadIdeas = async () => {
    setLoadingIdeas(true);
    try {
      const res = await api.ideas(5);
      setIdeas(res.ideas);
      setRestantes(res.restantes);
    } catch {
      setIdeas([]);
    } finally {
      setLoadingIdeas(false);
    }
  };

  const pickIdea = (idea: Idea) => {
    setTopic(idea.topic);
    setIdeaIndex(idea.index);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { jobId } = await api.createStory({
        topic, tone, styleId, sceneCount, variants, ideaIndex,
      });
      onCreated(jobId);
    } catch (err) {
      setError(describeError(err));
      setSubmitting(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <div>
        <h2>Nueva frutinovela</h2>
        <p className="small dim" style={{ margin: '6px 0 0' }}>
          Describe el tema en una frase. La IA arma el arco dramatico completo.
        </p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Generador aleatorio: quita la friccion de decidir que hacer hoy y
          garantiza que la premisa no se haya contado antes. */}
      <div className="card-inset stack" style={{ gap: 12 }}>
        <div className="row-between wrap">
          <div>
            <div style={{ fontWeight: 650, fontSize: '0.92rem' }}>Sorprendeme</div>
            <p className="tiny faint" style={{ margin: '4px 0 0' }}>
              {restantes !== null
                ? `${restantes.toLocaleString('es')} combinaciones sin usar`
                : 'Premisas que no se han contado todavia'}
            </p>
          </div>
          <button
            className="btn btn-sm"
            onClick={loadIdeas}
            disabled={loadingIdeas}
          >
            {loadingIdeas ? 'Pensando...' : ideas.length ? 'Otras 5' : 'Generar 5 ideas'}
          </button>
        </div>

        {ideas.length > 0 && (
          <div className="stack" style={{ gap: 7 }}>
            {ideas.map((idea) => (
              <button
                key={idea.index}
                className={`idea-card ${ideaIndex === idea.index ? 'idea-card-active' : ''}`}
                onClick={() => pickIdea(idea)}
                disabled={submitting}
              >
                <div className="idea-title">{idea.title}</div>
                <div className="idea-text">{idea.topic}</div>
              </button>
            ))}
            <p className="tiny faint">
              Al elegir una, deja de ofrecerse para que no se repita.
            </p>
          </div>
        )}
      </div>

      <div>
        <div className="row-between">
          <label className="label" htmlFor="topic">Tema</label>
          <span className={`tiny ${topic.length > 1100 ? 'counter-warn' : 'faint'}`}>
            {topic.length} / 1200
          </span>
        </div>
        <textarea
          id="topic"
          value={topic}
          onChange={(e) => {
            setTopic(e.target.value);
            // Si edita a mano, la propuesta deja de estar seleccionada.
            setIdeaIndex(undefined);
          }}
          placeholder="La fresa descubre que su novio es una ciruela y que la mandona esta al corriente."
          rows={3}
          required
          minLength={3}
          style={{ marginTop: 7 }}
        />
        <p className="tiny faint" style={{ margin: '6px 0 0' }}>
          Puedes pegar hasta 1200 caracteres: da para el argumento, los nombres
          de los personajes y el giro final.
        </p>
      </div>

      <div className="grid-styles">
        {styles.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`btn ${styleId === s.id ? 'btn-primary' : ''}`}
            style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '10px 13px' }}
            onClick={() => setStyleId(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="row wrap" style={{ gap: 14 }}>
        <div className="grow" style={{ minWidth: 200 }}>
          <label className="label" htmlFor="tone">Tono</label>
          <input
            id="tone"
            type="text"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            style={{ marginTop: 7 }}
          />
        </div>
        <div style={{ width: 120 }}>
          <label className="label" htmlFor="count">Planos</label>
          <input
            id="count"
            type="number"
            min={4}
            max={14}
            value={sceneCount}
            onChange={(e) => setSceneCount(Number(e.target.value))}
            style={{ marginTop: 7 }}
          />
        </div>
        <div style={{ width: 150 }}>
          <label className="label" htmlFor="variants">Tomas por plano</label>
          <select
            id="variants"
            value={variants}
            onChange={(e) => setVariants(Number(e.target.value))}
            style={{ marginTop: 7 }}
          >
            <option value={1}>1 · mas rapido</option>
            <option value={2}>2 · equilibrado</option>
            <option value={3}>3 · mejor calidad</option>
            <option value={4}>4 · maximo</option>
          </select>
        </div>
      </div>

      <div className="row-between wrap">
        <span className="tiny faint">
          Aproximadamente {sceneCount * variants + 4} llamadas a la API
          ({sceneCount} planos × {variants} tomas + fichas de personaje y voz).
          Puede tardar 3-8 minutos.
        </span>
        <button
          className="btn btn-primary"
          disabled={submitting || topic.trim().length < 3}
        >
          {submitting ? 'Iniciando...' : 'Generar frutinovela'}
        </button>
      </div>

      {/* Aviso antes de que el servidor rechace el envio. */}
      {topic.length > 1200 && (
        <div className="alert alert-error">
          El tema tiene {topic.length} caracteres y el máximo es 1200.
          Recorta el texto para poder generar.
        </div>
      )}
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Listado de historias
// ─────────────────────────────────────────────────────────────────────────────

export function StoryList({
  stories,
  onOpen,
  onDelete,
}: {
  stories: Array<{ id: string; title: string; premise: string; updatedAt: string; sceneCount: number; approvedCount: number }>;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (stories.length === 0) {
    return <p className="dim center small" style={{ padding: 30 }}>Todavia no hay historias.</p>;
  }

  return (
    <div className="grid-stories">
      {stories.map((s) => (
        <div className="card stack" key={s.id} style={{ gap: 12, padding: 16 }}>
          <div>
            <div style={{ fontWeight: 650 }}>{s.title}</div>
            <p className="small dim pre-wrap" style={{ margin: '6px 0 0' }}>{s.premise}</p>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="chip">{s.sceneCount} planos</span>
            <span className={`badge ${s.approvedCount === s.sceneCount ? 'badge-approved' : 'badge-draft'}`}>
              {s.approvedCount}/{s.sceneCount}
            </span>
          </div>
          <div className="row-between">
            <span className="tiny faint">{new Date(s.updatedAt).toLocaleDateString('es')}</span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn btn-sm" onClick={() => onDelete(s.id)}>Borrar</button>
              <button className="btn btn-primary btn-sm" onClick={() => onOpen(s.id)}>Abrir</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}