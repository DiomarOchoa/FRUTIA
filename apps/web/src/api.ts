/** Cliente HTTP de la API, con errores normalizados. */

import type { Story } from '@frutia/core';

export interface StorySummary {
  id: string;
  title: string;
  premise: string;
  createdAt: string;
  updatedAt: string;
  sceneCount: number;
  approvedCount: number;
  characterCount: number;
}

export interface StyleSpec {
  id: string;
  label: string;
  prompt: string;
}

export type PipelineStage =
  | 'script' | 'images' | 'voice' | 'subtitles' | 'compose' | 'export';

export interface StageProgress {
  stage: PipelineStage;
  completed: number;
  total: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  message?: string;
}

export interface Job {
  id: string;
  storyId?: string;
  kind: 'draft' | 'compose';
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: StageProgress[];
  outputPath?: string;
  error?: string;
}

export class ApiError extends Error {
  /** Detalle por campo cuando el servidor devuelve validacion. */
  readonly details: string[];

  constructor(message: string, readonly status: number, details: string[] = []) {
    super(message);
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      details?: string[];
    };
    const details = Array.isArray(body.details) ? body.details : [];
    throw new ApiError(body.error ?? `Error ${res.status}`, res.status, details);
  }

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Mensaje completo de un error, con los detalles de campo si los hay. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.details.length === 0) return err.message;
    return `${err.message}\n${err.details.map((d) => `· ${d}`).join('\n')}`;
  }
  return err instanceof Error ? err.message : 'Error desconocido.';
}

export const api = {
  health: () => request<{ ok: boolean; hasApiKey: boolean; queued: number }>('/api/health'),

  styles: () => request<StyleSpec[]>('/api/styles'),

  listStories: () => request<StorySummary[]>('/api/stories'),

  getStory: (id: string) => request<Story>(`/api/stories/${id}`),

  createStory: (input: {
    topic: string;
    sceneCount?: number;
    styleId?: string;
    tone?: string;
    locale?: string;
    seed?: number;
    /** Indice de la propuesta del generador, para marcarla como usada. */
    ideaIndex?: number;
    variants?: number;
    autoCompose?: boolean;
  }) => request<{ jobId: string }>('/api/stories', {
    method: 'POST',
    body: JSON.stringify(input),
  }),

  patchScene: (
    storyId: string,
    sceneId: string,
    patch: Partial<Pick<Story['scenes'][number], 'status' | 'narration' | 'shotDescription' | 'targetDuration' | 'activeVariant'>>,
  ) => request<Story>(`/api/stories/${storyId}/scenes/${sceneId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }),

  /** Regenera las imagenes de un plano. Tarda: por eso devuelve un jobId. */
  regenerateScene: (
    storyId: string,
    sceneId: string,
    opts: { variants?: number; regenerateVoice?: boolean } = {},
  ) => request<{ jobId: string }>(`/api/stories/${storyId}/scenes/${sceneId}/regenerate`, {
    method: 'POST',
    body: JSON.stringify(opts),
  }),

  reorderScenes: (storyId: string, sceneIds: string[]) =>
    request<Story>(`/api/stories/${storyId}/scenes/reorder`, {
      method: 'POST',
      body: JSON.stringify({ sceneIds }),
    }),

  duplicateScene: (storyId: string, sceneId: string) =>
    request<Story>(`/api/stories/${storyId}/scenes/${sceneId}/duplicate`, { method: 'POST' }),

  deleteScene: (storyId: string, sceneId: string) =>
    request<Story>(`/api/stories/${storyId}/scenes/${sceneId}`, { method: 'DELETE' }),

  compose: (storyId: string) =>
    request<{ jobId: string }>(`/api/stories/${storyId}/compose`, { method: 'POST' }),

  deleteStory: (storyId: string) => request<void>(`/api/stories/${storyId}`, { method: 'DELETE' }),

  getJob: (jobId: string) => request<Job>(`/api/jobs/${jobId}`),

  /** Cancela un trabajo pendiente o en curso. */
  cancelJob: (jobId: string) => request<void>(`/api/jobs/${jobId}`, { method: 'DELETE' }),

  /** Propuestas aleatorias que no se han usado todavia. */
  ideas: (count = 5) =>
    request<{ ideas: Idea[]; usadas: number; restantes: number }>(`/api/ideas?count=${count}`),

  markIdeaUsed: (idea: { index: number; topic: string; title: string }) =>
    request<void>('/api/ideas/usada', { method: 'POST', body: JSON.stringify(idea) }),
};

/** Propuesta del generador aleatorio. */
export interface Idea {
  topic: string;
  title: string;
  index: number;
  seed: number;
}

/** URL publica de un artefacto generado (imagen, audio o video). */
export function artifactUrl(filePath: string | undefined): string | null {
  if (!filePath) return null;
  // El pipeline guarda rutas absolutas; al navegador solo le interesa la parte
  // relativa al directorio de almacenamiento, que es lo que sirve el static.
  const normalized = filePath.replace(/\\/g, '/');
  const marker = '/storage/';
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return null;
  return `/storage/${normalized.slice(idx + marker.length)}`;
}