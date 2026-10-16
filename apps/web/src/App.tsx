import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Job, type StyleSpec, type StorySummary } from './api';
import { JobProgress, useJob } from './JobProgress';
import { NewStoryForm, StoryEditor, StoryList } from './components';
import type { Story } from '@frutia/core';

type View = { name: 'list' } | { name: 'new' } | { name: 'editor'; id: string };

export default function App() {
  const [view, setView] = useState<View>({ name: 'list' });
  const [stories, setStories] = useState<StorySummary[]>([]);
  const [styles, setStyles] = useState<StyleSpec[]>([]);
  const [story, setStory] = useState<Story | null>(null);
  const [draftJobId, setDraftJobId] = useState<string | null>(null);
  const [health, setHealth] = useState<{ hasApiKey: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listLoadFailed, setListLoadFailed] = useState(false);
  const [listRetryAttempt, setListRetryAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  const draftJob = useJob(draftJobId);

  /** Cancela el trabajo en curso y limpia el estado para volver a empezar. */
  const cancelDraft = async () => {
    if (!draftJobId) return;
    try {
      await api.cancelJob(draftJobId);
      setDraftJobId(null);
    } catch {
      // Si ya termino, simplemente se deja de seguirlo.
      setDraftJobId(null);
    }
  };

  const refresh = useCallback(async () => {
    try {
      setStories(await api.listStories());
      setError(null);
      setListLoadFailed(false);
      setListRetryAttempt(0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar la lista.');
      setListLoadFailed(true);
      setListRetryAttempt((attempt) => attempt + 1);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api.health().then(setHealth).catch(() => undefined);
    void api.styles().then(setStyles).catch(() => undefined);
  }, [refresh]);

  // Si la API está reiniciando cuando abre el navegador, recuperar la
  // biblioteca sin exigirle al usuario que recargue manualmente la página.
  useEffect(() => {
    if (!listLoadFailed || view.name !== 'list') return;
    const exponent = Math.min(Math.max(listRetryAttempt - 1, 0), 5);
    const delay = Math.min(1_000 * 2 ** exponent, 30_000);
    const timer = window.setTimeout(() => { void refresh(); }, delay);
    return () => window.clearTimeout(timer);
  }, [listLoadFailed, listRetryAttempt, view.name, refresh]);

  // Cuando el borrador termina, abrimos la historia para revisarla.
  useEffect(() => {
    if (draftJob?.status === 'done' && draftJob.storyId) {
      const id = draftJob.storyId;
      setDraftJobId(null);
      void openStory(id);
      void refresh();
    }
  }, [draftJob?.status, draftJob?.storyId]);

  const openStory = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setStory(await api.getStory(id));
      setView({ name: 'editor', id });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo abrir la historia.');
    } finally {
      setBusy(false);
    }
  };

  const deleteStory = async (id: string) => {
    if (!confirm('Borrar la historia y sus archivos?')) return;
    try {
      await api.deleteStory(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo borrar.');
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-dot" /> Frutia</div>

        <nav className="row" style={{ gap: 6 }}>
          <button
            className={`btn btn-sm ${view.name === 'list' ? 'btn-primary' : ''}`}
            onClick={() => { setView({ name: 'list' }); void refresh(); }}
          >
            Historias
          </button>
          <button
            className={`btn btn-sm ${view.name === 'new' ? 'btn-primary' : ''}`}
            onClick={() => { setDraftJobId(null); setView({ name: 'new' }); }}
          >
            Nueva
          </button>
        </nav>

        <div className="grow" />

        {health && !health.hasApiKey && (
          <span className="badge badge-rejected">Falta GEMINI_API_KEY</span>
        )}
      </header>

      <main className="main stack">
        {error && (
          <div className="alert alert-error" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span>{error}</span>
            {view.name === 'list' && (
              <button className="btn btn-sm" onClick={() => { void refresh(); }}>Reintentar</button>
            )}
          </div>
        )}

        {view.name === 'new' && (
          <>
            <NewStoryForm
              styles={styles}
              onCreated={(jobId: string) => {
                setDraftJobId(jobId);
                setView({ name: 'list' });
              }}
            />
            {draftJob && <JobProgress job={draftJob} onCancel={cancelDraft} />}
          </>
        )}

        {view.name === 'list' && (
          <>
            <StoryList
              stories={stories}
              onOpen={openStory}
              onDelete={deleteStory}
              onCreate={() => setView({ name: 'new' })}
            />
            {draftJob && <JobProgress job={draftJob} onCancel={cancelDraft} />}
          </>
        )}

        {view.name === 'editor' && (story ? (
          <StoryEditor
            story={story}
            onClose={() => { setView({ name: 'list' }); setStory(null); void refresh(); }}
            onChanged={refresh}
          />
        ) : (
          <p className="dim small">{busy ? 'Cargando...' : 'Historia no disponible.'}</p>
        ))}
      </main>
    </div>
  );
}
