/**
 * API de Frutia.
 *
 * Expone el pipeline como trabajos asincronos y sirve los artefactos (imagenes,
 * audio, video) como archivos estaticos. El diseño sigue una regla: la API
 * genera, pero nunca publica. No hay endpoint que postee en TikTok, y esa es
 * una decision de producto, no una funcionalidad pendiente.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';

import {
  DomainError,
  GEMINI_VOICES,
  ImageProvider,
  LlmProvider,
  TtsProvider,
  composeFinal,
  deleteScene,
  duplicateScene,
  regenerateScene,
  reorderScenes,
  runDraftPipeline,
  type PipelineDeps,
} from '@frutia/core';

import { JobQueue } from './jobs.js';
import { NotFoundError, StoryStore, ValidationError } from './store.js';
import { IdeaHistory } from './idea-history.js';

const PORT = Number(process.env.PORT ?? 4000);
const STORAGE_DIR = process.env.STORAGE_DIR ?? path.resolve(process.cwd(), '../../storage');

/**
 * Limpia el BOM de las variables de entorno.
 *
 * PowerShell escribe los archivos con `Set-Content -Encoding UTF8` con marca de
 * orden de bytes, y esa marca se queda pegada al nombre de la primera variable:
 * el resultado es que `GEMINI_API_KEY` llega como `﻿GEMINI_API_KEY` y no
 * existe. Es un fallo silencioso y confuso, asi que se corrige aqui.
 */
function env(name: string): string {
  return (process.env[name] ?? '').replace(/^\uFEFF/, '').trim();
}

const GEMINI_API_KEY = env('GEMINI_API_KEY');

/**
 * Voz de Google, solo si el nombre es valido para Gemini.
 *
 * `FRUTIA_VOICE` puede contener una voz del proveedor gratuito (por ejemplo
 * "nova"), que no existe en Gemini. Pasarla tal cual haria fallar el arranque,
 * asi que se filtra aqui.
 */
function geminiVoice(): string {
  const requested = env('FRUTIA_VOICE');
  if (!requested) return '';
  return GEMINI_VOICES.includes(requested as (typeof GEMINI_VOICES)[number]) ? requested : '';
}

// Concurrencia baja a proposito: respeta los rate limits del free tier.
const CONCURRENCY = Number(env('JOB_CONCURRENCY') || '2');

const store = new StoryStore(STORAGE_DIR);
const queue = new JobQueue(CONCURRENCY);
const ideas = new IdeaHistory(path.join(STORAGE_DIR, 'ideas-usadas.json'));

const deps = (): PipelineDeps => ({
  llm: new LlmProvider({ apiKey: GEMINI_API_KEY }),
  // "auto" usa Google y cae a Pollinations si la cuota de imagenes se agota.
  image: new ImageProvider({
    apiKey: GEMINI_API_KEY,
    prefer: (env('FRUTIA_IMAGE_PROVIDER') as 'auto' | 'gemini' | 'pollinations') || 'auto',
  }),
  // La voz usa Google y, si su cuota se agota, cae sola al proveedor gratuito
  // con la misma clave de Pollinations que ya sirve para las imagenes.
  tts: new TtsProvider({ apiKey: GEMINI_API_KEY, defaultVoice: geminiVoice() || undefined }),
  storageDir: STORAGE_DIR,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// Esquemas de entrada
// ─────────────────────────────────────────────────────────────────────────────

const createStorySchema = z.object({
  // 1200 caracteres permiten pegar un resumen del guion con los personajes
  // described, sin tener que recortar hasta que quepa. El LLM tiene ventana
  // de sobra para procesarlo.
  topic: z.string().min(3, 'Escribe un tema de al menos 3 caracteres.').max(1200,
    'El tema es demasiado largo (máximo 1200 caracteres). Resume el argumento.'),
  sceneCount: z.number().int().min(4).max(14).optional(),
  styleId: z.string().optional(),
  tone: z.string().max(300).optional(),
  locale: z.string().max(12).optional(),
  seed: z.number().int().optional(),
  imageSeed: z.number().int().optional(),
  /** Indice de la idea del generador, si la topic viene de "Sorprendeme". */
  ideaIndex: z.number().int().optional(),
  /** Cuantas imagenes candidatas por plano (1 a 4). */
  variants: z.number().int().min(1).max(4).optional(),
  /** Si se omite, el pipeline se detiene tras generar y espera curacion. */
  autoCompose: z.boolean().default(false),
});

const patchSceneSchema = z.object({
  status: z.enum(['draft', 'generated', 'approved', 'rejected']).optional(),
  narration: z.string().max(2000).optional(),
  shotDescription: z.string().max(600).optional(),
  targetDuration: z.number().min(0.5).max(30).optional(),
  activeVariant: z.number().int().min(0).optional(),
});

const regenerateSchema = z.object({
  variants: z.number().int().min(1).max(4).default(1),
  imageSeed: z.number().int().optional(),
  /** Regenera tambien la voz: necesario si se edito la narracion. */
  regenerateVoice: z.boolean().default(false),
});

const reorderSchema = z.object({
  sceneIds: z.array(z.string()).min(1),
});

// ─────────────────────────────────────────────────────────────────────────────
// Rutas
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(GEMINI_API_KEY),
    queued: queue.list().filter((j) => j.status === 'queued' || j.status === 'running').length,
  });
});

/**
 * Prueba de conectividad con los tres proveedores.
 *
 * Es el primer sitio donde hay que mirar cuando algo falla: distingue "la clave
 * esta mal" de "el modelo ya no existe" de "no hay cuota", que son fallos muy
 * distintos con soluciones muy distintas.
 *
 *   /api/check                 -> solo la voz, que es gratis e ilimitada
 *   /api/check?llm=1           -> ademas el guion. GASTA 1 de las 20 diarias
 *   /api/check?llm=1&images=1  -> todo. Gasta cuota y tarda
 *
 * El guion solo se prueba si se pide: el free tier de Gemini da 20 peticiones
 * al dia, y una prueba de diagnostico que las gasta deja al usuario sin poder
 * generar. Las imagenes tambien son optimas porque ocupan el hueco de una
 * peticion mas entre reintentos en el proveedor gratuito.
 */
app.get('/api/check', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.json({ ok: false, error: 'Falta GEMINI_API_KEY en el servidor.' });
  }

  const includeLlm = req.query.llm === '1';
  const includeImages = req.query.images === '1';
  const d = deps();
  const results: Record<string, { ok: boolean; detail: string }> = {};

  // El guion es el UNICO motor con limite: el free tier de Gemini da 20
  // peticiones al dia y cada prueba de diagnostico gasta una. Por eso aqui no
  // se toca salvo que se pida con ?llm=1. Una prueba que consume cuota deja al
  // usuario sin poder generar su frutinovela.
  if (includeLlm) {
    try {
      const text = await d.llm.complete(
        'Responde solo con la palabra: listo',
        'confirma que funcionas',
      );
      results.llm = { ok: Boolean(text), detail: text.slice(0, 60) };
    } catch (error) {
      results.llm = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  } else {
    results.llm = { ok: true, detail: 'no comprobado (gasta cuota · usa ?llm=1)' };
  }

  try {
    const audio = await d.tts.speak({ text: 'Te menti todo el tiempo.' });
    results.tts = {
      ok: Boolean(audio.base64),
      detail: `${d.tts.lastBackend} · ${audio.mimeType} · ${Math.round(audio.base64.length / 1024)} KB`,
    };
  } catch (error) {
    results.tts = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  // Las imagenes van al final y son opcionales: son la llamada mas cara y la
  // que mas rate limit sufre.
  if (includeImages) {
    try {
      const img = await d.image.generate({ prompt: 'Una manzana roja sobre fondo blanco' });
      results.image = {
        ok: Boolean(img.base64),
        detail: `${d.image.lastBackend} · ${Math.round(img.base64.length / 1024)} KB`,
      };
    } catch (error) {
      results.image = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  } else {
    results.image = { ok: true, detail: 'no comprobado · anade ?images=1' };
  }

  res.json({ ok: Object.values(results).every((r) => r.ok), results });
});

app.get('/api/styles', async (_req, res) => {
  const { STYLES } = await import('@frutia/core');
  res.json(STYLES);
});

/**
 * Propuestas aleatorias que no se han usado todavia.
 *
 * Resuelve la friccion de "que hago hoy" y evita la repeticion: el historial
 * se descuenta de las combinaciones disponibles y, dentro de la respuesta, se
 * filtran las que solo cambian de fruta respecto a otra ya propuesta.
 */
app.get('/api/ideas', async (req, res, next) => {
  try {
    const count = Math.min(10, Math.max(1, Number(req.query.count) || 5));
    const used = await ideas.usedIndexes();
    const { suggestIdeas, remainingCombinations } = await import('@frutia/core');

    res.json({
      ideas: suggestIdeas(used, count),
      usadas: used.length,
      restantes: remainingCombinations(used.length),
    });
  } catch (error) { next(error); }
});

/** Marca una propuesta como usada. Se llama al generar la historia. */
app.post('/api/ideas/usada', async (req, res, next) => {
  try {
    const { index, topic, title, storyId } = z.object({
      index: z.number().int(),
      topic: z.string().max(400),
      title: z.string().max(120).default(''),
      storyId: z.string().max(64).optional(),
    }).parse(req.body);

    await ideas.add({
      index, topic, title, storyId,
      at: new Date().toISOString(),
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.delete('/api/ideas', async (_req, res, next) => {
  try {
    await ideas.clear();
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/stories', async (_req, res, next) => {
  try {
    const stories = await store.list();
    // El listado no necesita las escenas completas; pesarian demasiado.
    res.json(stories.map(({ scenes, characters, ...rest }) => ({
      ...rest,
      sceneCount: scenes.length,
      approvedCount: scenes.filter((s) => s.status === 'approved').length,
      characterCount: characters.length,
    })));
  } catch (error) { next(error); }
});

app.get('/api/stories/:id', async (req, res, next) => {
  try {
    const story = await store.get(req.params.id);
    if (!story) throw new NotFoundError('Historia no encontrada.');
    res.json(story);
  } catch (error) { next(error); }
});

app.post('/api/stories', async (req, res, next) => {
  try {
    if (!GEMINI_API_KEY) {
      throw new ValidationError('Falta GEMINI_API_KEY en el servidor.');
    }
    const input = createStorySchema.parse(req.body);

    const job = queue.enqueue('draft', undefined, async (job, emit) => {
      // La cancelacion se conecta aqui: el pipeline la consulta entre etapas.
      const stopped = { flag: false };
      queue.bindCancel(job.id, () => { stopped.flag = true; });

      const story = await runDraftPipeline(
        {
          ...deps(),
          onProgress: emit,
          shouldStop: () => {
            if (stopped.flag) throw new DomainError('Cancelado por el usuario.', 'invalid');
          },
        },
        {
          topic: input.topic,
          sceneCount: input.sceneCount,
          styleId: input.styleId,
          tone: input.tone,
          locale: input.locale,
          seed: input.seed ?? input.ideaIndex,
          imageSeed: input.imageSeed,
          variants: input.variants,
        },
      );

      await store.save(story);
      job.storyId = story.id;

      // Una idea generada se marca como usada: volver a proponerla seria
      // repetirla en el canal, y el usuario no tendria forma de enterarse.
      if (input.ideaIndex !== undefined) {
        await ideas.add({
          index: input.ideaIndex,
          topic: input.topic,
          title: story.title,
          storyId: story.id,
          at: new Date().toISOString(),
        });
      }

      // `autoCompose` solo tiene efecto en desarrollo: en produccion la
      // aprobacion humana es obligatoria y no se puede saltar.
      if (input.autoCompose && process.env.NODE_ENV !== 'production') {
        await composeFinal({ ...deps(), onProgress: emit }, story, {
          quality: 'standard',
          requireApproval: false,
        });
      }
      return story.id;
    });

    res.status(202).json({ jobId: job.id });
  } catch (error) { next(error); }
});

app.patch('/api/stories/:id/scenes/:sceneId', async (req, res, next) => {
  try {
    const patch = patchSceneSchema.parse(req.body);
    const story = await store.patchScene(req.params.id, req.params.sceneId, patch);
    res.json(story);
  } catch (error) { next(error); }
});

/**
 * Compone el video final. Solo se renderizan planos aprobados cuando el
 * servidor corre en produccion: es la barrera que impide publicar sin revision.
 */
app.post('/api/stories/:id/compose', async (req, res, next) => {
  try {
    const story = await store.get(req.params.id);
    if (!story) throw new NotFoundError('Historia no encontrada.');

    const requireApproval = process.env.NODE_ENV === 'production';

    const job = queue.enqueue('compose', story.id, async (_job, emit) => {
      const outputPath = await composeFinal(
        { ...deps(), onProgress: emit },
        story,
        { quality: 'standard', requireApproval },
      );
      return outputPath;
    });

    res.status(202).json({ jobId: job.id });
  } catch (error) { next(error); }
});

/**
 * Regenera las imagenes de un plano concreto.
 *
 * Se encola porque son llamadas a la API externa; devolverlas por HTTP dejaria
 * al cliente esperando con riesgo de timeout. La operacion mas repetida del
 * producto: una toma mala no obliga a rehacer la historia entera.
 */
app.post('/api/stories/:id/scenes/:sceneId/regenerate', async (req, res, next) => {
  try {
    if (!GEMINI_API_KEY) throw new ValidationError('Falta GEMINI_API_KEY en el servidor.');
    const input = regenerateSchema.parse(req.body ?? {});

    const story = await store.get(req.params.id);
    if (!story) throw new NotFoundError('Historia no encontrada.');
    if (!story.scenes.some((s) => s.id === req.params.sceneId)) {
      throw new NotFoundError('Plano no encontrado.');
    }

    const job = queue.enqueue('regenerate', story.id, async (_job, emit) => {
      const updated = await store.mutate(story.id, async (draft) => {
        await regenerateScene({ ...deps(), onProgress: emit }, draft, req.params.sceneId, {
          variants: input.variants,
          imageSeed: input.imageSeed ?? Date.now() % 100_000,
          regenerateVoice: input.regenerateVoice,
        });
      });
      return updated.id;
    });

    res.status(202).json({ jobId: job.id });
  } catch (error) { next(error); }
});

/** Reordena los planos. Los indices se recalculan en el servidor. */
app.post('/api/stories/:id/scenes/reorder', async (req, res, next) => {
  try {
    const input = reorderSchema.parse(req.body);
    const updated = await store.mutate(req.params.id, (story) => {
      reorderScenes(story, input.sceneIds);
    });
    res.json(updated);
  } catch (error) { next(error); }
});

/** Duplica un plano, incluida su imagen y su audio. No llama a ninguna IA. */
app.post('/api/stories/:id/scenes/:sceneId/duplicate', async (req, res, next) => {
  try {
    const updated = await store.mutate(req.params.id, (story) => {
      duplicateScene(story, req.params.sceneId);
    });
    res.json(updated);
  } catch (error) { next(error); }
});

app.delete('/api/stories/:id/scenes/:sceneId', async (req, res, next) => {
  try {
    const updated = await store.mutate(req.params.id, (story) => {
      deleteScene(story, req.params.sceneId);
    });
    res.json(updated);
  } catch (error) { next(error); }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = queue.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Trabajo no encontrado.' });
  res.json(job);
});

app.get('/api/jobs', (_req, res) => {
  res.json(queue.list());
});

/**
 * Cancela un trabajo pendiente o en curso.
 *
 * Necesario porque generar una historia son varias llamadas de imagen, y sin
 * salida el usuario que se equivoca al enviar tiene que esperar minutos sin
 * poder hacer otra cosa.
 */
app.delete('/api/jobs/:id', (req, res) => {
  const ok = queue.cancel(req.params.id);
  if (!ok) {
    const job = queue.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Trabajo no encontrado.' });
    return res.status(409).json({ error: `El trabajo ya termino (${job.status}).` });
  }
  res.status(204).end();
});

app.delete('/api/stories/:id', async (req, res, next) => {
  try {
    await store.delete(req.params.id);
    res.status(204).end();
  } catch (error) { next(error); }
});

// Artefactos generados: imagenes, audio y el MP4 final.
app.use('/storage', express.static(STORAGE_DIR, { maxAge: '1h' }));

/** Sirve el MP4 de una historia, con el nombre correcto para descargar. */
app.get('/api/stories/:id/video', (req, res) => {
  const file = path.join(STORAGE_DIR, req.params.id, `${req.params.id}.mp4`);
  if (!existsSync(file)) return res.status(404).json({ error: 'El video aun no existe.' });
  res.download(file, `${req.params.id}.mp4`);
});

/** Nombres de campo en castellano, para que el error sea entendible. */
const CAMPOS: Record<string, string> = {
  topic: 'Tema',
  tone: 'Tono',
  styleId: 'Estilo',
  sceneCount: 'Numero de planos',
  variants: 'Tomas por plano',
  seed: 'Semilla',
  imageSeed: 'Semilla de imagen',
  ideaIndex: 'Idea',
  locale: 'Idioma',
  sceneIds: 'Lista de planos',
  activeVariant: 'Variante',
  shotDescription: 'Descripcion de la toma',
  narration: 'Narracion',
  targetDuration: 'Duracion',
  regenerateVoice: 'Regenerar voz',
};

function campoLegible(path: PropertyKey[]): string {
  return path.map(String).map((p) => CAMPOS[p] ?? p).join(' > ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Errores
// ─────────────────────────────────────────────────────────────────────────────

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
  return res.status(400).json({
    error: 'Revisa estos campos:',
    details: error.issues.map((i) => {
      // Se usa el mensaje a proposito: el de Zod explica el limite concreto,
      // que es justo lo que el usuario necesita para corregir el formulario.
      return `${campoLegible(i.path)}: ${i.message}`;
    }),
  });
}
  if (error instanceof NotFoundError) return res.status(404).json({ error: error.message });
  if (error instanceof ValidationError) return res.status(400).json({ error: error.message });

  // El nucleo distingue "no existe" de "peticion invalida" sin conocer HTTP.
  // Sin esta traduccion, un plano inexistente devolvia 500 y se confundia un
  // error de cliente con una averia del servidor.
  if (error instanceof DomainError) {
    return res.status(error.code === 'not_found' ? 404 : 400).json({ error: error.message });
  }

  const message = error instanceof Error ? error.message : 'Error desconocido.';
  console.error('[frutia]', error);
  res.status(500).json({ error: message });
});

// ─────────────────────────────────────────────────────────────────────────────

await store.init();
// Escucha en todas las interfaces. Sin esto Node se ata a ::1 y las
// peticiones que llegan por IPv4 (127.0.0.1) se rechazan con 502.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Frutia API en http://localhost:${PORT}`);
  console.log(`Artefactos en ${STORAGE_DIR}`);
  if (!GEMINI_API_KEY) console.warn('AVISO: falta GEMINI_API_KEY; la generacion no funcionara.');
});