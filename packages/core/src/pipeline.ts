/**
 * Orquestacion del pipeline de produccion de una frutinovela.
 *
 * La regla de oro de este archivo: cada plano pasa por las etapas de imagen,
 * voz y subtitulo, pero NUNCA se marca como `approved`. Esa transicion la hace
 * una persona desde la interfaz. Es lo que separa a Frutia de una fabrica de
 * contenido que TikTok marca como no original y le niegan la monetizacion.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DomainError, type Character, type Scene, type Story, type StoryConfig, type StageProgress } from './types.js';
import {
  SYSTEM_PROMPT,
  buildCharacterSheetPrompt,
  buildScriptUserPrompt,
  buildSceneImagePrompt,
  parseStoryResponse,
} from './prompts.js';
import { LlmProvider } from './providers/llm.js';
import { ImageProvider } from './providers/image.js';
import { TtsProvider } from './providers/tts.js';
import { buildAss, cuesFromScene, type CueTiming } from './render/subtitles.js';
import { composeStory, probeDuration, probeSpeechSpan, writeBase64File, type Shot } from './render/ffmpeg.js';

export interface PipelineDeps {
  llm: LlmProvider;
  image: ImageProvider;
  tts: TtsProvider;
  /** Directorio raiz de artefactos. */
  storageDir: string;
  onProgress?: (p: StageProgress) => void;
  /**
   * Se invoca entre etapas. Si lanza, el pipeline se detiene.
   *
   * Permite cancelar sin matar el proceso a mitad de una escritura, que
   * dejaria archivos truncados en disco.
   */
  shouldStop?: () => void;
}

/** Falla si el trabajo fue cancelado mientras se esperaba. */
function checkStop(deps: PipelineDeps): void {
  deps.shouldStop?.();
}

export interface PipelineResult {
  story: Story;
  outputPath?: string;
}

/**
 * Duracion minima para que TikTok considere pagable el video.
 *
 * Esta en el nucleo, no en la interfaz, porque el umbral es una regla de la
 * plataforma y debe cumplirse igual se mida desde donde se mida.
 */
export const MIN_MONETIZABLE_SEC = 60;

/**
 * Cuenta la duracion total de los planos que se van a renderizar.
 *
 * Solo cuenta los aprobados cuando la curacion es obligatoria: un plano
 * descartado no suma, y medirlo engañaria al usuario sobre si llega al minuto.
 */
export function totalDuration(story: Story, opts: { requireApproval: boolean }): number {
  return story.scenes
    .filter((s) => (opts.requireApproval ? s.status === 'approved' : s.status !== 'rejected'))
    .reduce((acc, s) => acc + (s.targetDuration || 0), 0);
}

/** Faltan segundos para alcanzar el minimo, o 0 si ya se alcanza. */
export function secondsToMonetizable(story: Story, opts: { requireApproval: boolean }): number {
  return Math.max(0, MIN_MONETIZABLE_SEC - totalDuration(story, opts));
}

// ─────────────────────────────────────────────────────────────────────────────
// Etapa 1: guion y hoja de personaje
// ─────────────────────────────────────────────────────────────────────────────

export async function writeScript(
  deps: PipelineDeps,
  opts: { topic: string; sceneCount?: number; styleId?: string; tone?: string; locale?: string; seed?: number; isFullScript?: boolean },
): Promise<Story> {
  deps.onProgress?.({ stage: 'script', completed: 0, total: 1, status: 'running', message: 'Escribiendo guion' });

  const raw = await deps.llm.complete(
    SYSTEM_PROMPT,
    buildScriptUserPrompt({
      topic: opts.topic,
      isFullScript: opts.isFullScript,
      sceneCount: opts.sceneCount,
      styleId: opts.styleId,
      tone: opts.tone,
      locale: opts.locale,
      seed: opts.seed,
    }),
  );

  const story = parseStoryResponse(raw, randomUUID(), opts.styleId);
  story.locale = opts.locale ?? 'es-419';
  deps.onProgress?.({ stage: 'script', completed: 1, total: 1, status: 'done', message: `${story.scenes.length} planos` });
  return story;
}

// ─────────────────────────────────────────────────────────────────────────────
// Etapa 2: imagenes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera una imagen por plano.
 *
 * Primero crea la hoja de personaje de cada uno y la reutiliza como referencia
 * en todos los planos donde aparece. Ese es el mecanismo de consistencia: el
 * modelo ve la cara exacta del personaje mientras compone cada toma.
 *
 * `variants` por plano produce varias candidatas de una sentada. El generador
 * de imagen es estocastico, asi que tres tomas del mismo prompt se parecen pero
 * no son identicas: elegir a ojo cuesta mucho menos que tres generaciones
 * separadas esperando cada una.
 */
export async function generateImages(
  deps: PipelineDeps,
  story: Story,
  opts: { variants?: number; imageSeed?: number; resume?: boolean } = {},
): Promise<Story> {
  const dir = path.join(deps.storageDir, story.id, 'scenes');
  await mkdir(dir, { recursive: true });
  const variantCount = Math.max(1, Math.min(4, opts.variants ?? 1));

  // Reanudar una historia a medio generar.
  //
  // El modo $0 hace que esto sea la norma y no la excepcion: el proveedor
  // gratuito falla de varias maneras a la vez, asi que una historia de trece
  // planos suele detenerse en el ocho o el nueve. Sin esto, el segundo intento
  // vuelve a pagar las cuatro fichas de personaje y los siete planos que ya
  // estaban bien, y vuelve a caer en el mismo sitio.
  //
  // Solo se reutiliza lo que esta REAL en disco. Un plano marcado como
  // generado con su archivo borrado se vuelve a hacer: dar por buena una
  // imagen que no existe es peor que repetirla.
  const resume = opts.resume ?? true;
  let reutilizadas = 0;

  // Pollinations ignora referencias visuales: saltar estas llamadas ahorra
  // una imagen por personaje sin cambiar el resultado de ese proveedor.
  if (deps.image.supportsReferenceImages) {
    for (const character of story.characters) {
      if (character.referenceImagePath && existeEnDisco(character.referenceImagePath)) continue;
      deps.onProgress?.({ stage: 'images', completed: 0, total: story.scenes.length,
        status: 'running', message: `Preparando personaje: ${character.name}` });
      const prompt = buildCharacterSheetPrompt(character, story.visualStyleId);
      const { base64 } = await deps.image.generate({ prompt });
      const out = path.join(dir, `ref-${character.id}.png`);
      await writeBase64File(base64, out);
      character.referenceImagePath = out;
    }
  }

  // Mantener el progreso ordenado mientras un pequeño grupo genera planos.
  // Los proveedores anónimos/Google permanecen secuenciales por sus cuotas.
  //
  // El `?? 1` y el `Number.isFinite` no son decimales: `Math.max(1, Math.min(undefined, n))`
  // da `NaN`, `Array.from({ length: NaN })` da un array VACÍO y el bucle de
  // trabajadores no arranca ni uno solo. El pipeline termina "con éxito" con
  // cero imágenes y sin decir nada: el fallo más caro posible, porque el
  // usuario ve la historia completa y solo un MP4 que no se puede componer.
  // Cualquier proveedor que no declare `recommendedConcurrency` disparaba eso.
  let completed = 0;
  let cursor = 0;
  const pedido = deps.image.recommendedConcurrency;
  const limite = Number.isFinite(pedido) && (pedido as number) >= 1 ? Math.floor(pedido as number) : 1;
  const concurrency = Math.max(1, Math.min(limite, story.scenes.length));
  const worker = async () => {
    while (true) {
      const scene = story.scenes[cursor++];
      if (!scene) return;
      checkStop(deps);

      // Un plano ya completo y presente en disco no se vuelve a pedir.
      if (resume && tieneImagenesUtiles(scene, variantCount)) {
        reutilizadas++;
        scene.activeVariant = Math.min(scene.activeVariant, scene.variants.length - 1);
        scene.status = 'generated';
        completed++;
        deps.onProgress?.({ stage: 'images', completed, total: story.scenes.length,
          status: 'running', message: `Plano ${scene.index} ya estaba listo` });
        continue;
      }

      deps.onProgress?.({ stage: 'images', completed, total: story.scenes.length,
        status: 'running', message: `Generando plano ${scene.index} de ${story.scenes.length}` });

      const cast = castFor(story, scene);
      const references = deps.image.supportsReferenceImages ? await loadReferences(cast) : [];
      const prompt = buildSceneImagePrompt(scene.shotDescription, cast, story.visualStyleId, story.visualStyle);
      scene.variants = [];
      for (let v = 0; v < variantCount; v++) {
        checkStop(deps);
        const { base64 } = await deps.image.generate({
          prompt,
          referenceImages: references,
          seed: opts.imageSeed === undefined ? undefined : opts.imageSeed + scene.index * 100 + v,
        });
        const out = path.join(dir, `${scene.id}-v${v}.png`);
        await writeBase64File(base64, out);
        scene.variants.push(out);
      }
      scene.activeVariant = 0;
      scene.attempts += variantCount;
      scene.status = 'generated';
      completed++;
      deps.onProgress?.({ stage: 'images', completed, total: story.scenes.length,
        status: 'running', message: `${completed} de ${story.scenes.length} planos listos` });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (reutilizadas > 0) {
    deps.onProgress?.({ stage: 'images', completed: story.scenes.length, total: story.scenes.length,
      status: 'done', message: `${reutilizadas} planos ya estaban listos` });
  }

  // Comprobacion de la ultima linea. Todo lo de arriba puede "terminar bien"
  // y no haber producido nada: un planificador mal calculado, un proveedor que
  // se traga los errores, un `scene.variants` que se sobrescribe. Sin esto, el
  // trabajo se guarda como completo con una historia sin imagenes y el fallo
  // solo aparece tres etapas mas tarde, cuando el render dice que no hay tomas.
  const sinImagenes = story.scenes.filter((s) => !s.variants?.length);
  if (sinImagenes.length > 0) {
    throw new DomainError(
      `No se genero ninguna imagen para ${sinImagenes.length} de ${story.scenes.length} planos ` +
      `(primero: ${sinImagenes[0]!.index}). Revisa las claves y el proveedor de imagenes.`,
      'invalid',
    );
  }

  deps.onProgress?.({ stage: 'images', completed: story.scenes.length, total: story.scenes.length, status: 'done' });
  return story;
}

/** Un archivo existe y pesa lo bastante para ser una imagen de verdad. */
function existeEnDisco(ruta: string | undefined): boolean {
  if (!ruta) return false;
  try {
    return statSync(ruta).size > 1024;
  } catch {
    return false;
  }
}

/**
 * ¿Este plano ya se puede reutilizar tal cual?
 *
 * Exige las tres cosas: las variantes que hacen falta, que los archivos sigan
 * ahi y que no sean de 0 bytes. Un plano marcado como listo con el archivo
 * borrado tiene que volver a generarse: dar por buena una imagen que no existe
 * rompe el render mas tarde, cuando ya es mas caro de diagnosticar.
 */
function tieneImagenesUtiles(scene: Scene, variantCount: number): boolean {
  if (scene.variants.length < variantCount) return false;
  return scene.variants.every((v) => existeEnDisco(v));
}

/** Personajes visibles en un plano. */
function castFor(story: Story, scene: Scene): Character[] {
  return scene.characterIds
    .map((id) => story.characters.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
}

/**
 * Regenera las imagenes de un plano sin tocar el resto de la historia.
 *
 * Es la operacion que mas se repite: una toma queda mal y rehacer las trece
 * llamadas del pipeline cuesta tiempo y cuota. Aqui solo se paga una toma.
 *
 * El plano vuelve a `generated` y nunca conserva la aprobacion: si la imagen
 * cambia, la persona tiene que volver a mirarla. Esa es la misma barrera de
 * curaduria del resto del producto.
 */
export async function regenerateScene(
  deps: PipelineDeps,
  story: Story,
  sceneId: string,
  opts: { variants?: number; imageSeed?: number; regenerateVoice?: boolean } = {},
): Promise<Scene> {
  const scene = story.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new DomainError(`No existe el plano ${sceneId}`, 'not_found');

  const dir = path.join(deps.storageDir, story.id, 'scenes');
  await mkdir(dir, { recursive: true });
  const variantCount = Math.max(1, Math.min(4, opts.variants ?? 1));

  const references = await loadReferences(castFor(story, scene));
  const prompt = buildSceneImagePrompt(
    scene.shotDescription, castFor(story, scene), story.visualStyleId, story.visualStyle,
  );

  for (let v = 0; v < variantCount; v++) {
    const { base64 } = await deps.image.generate({
      prompt,
      referenceImages: references,
      seed: opts.imageSeed === undefined ? undefined : opts.imageSeed + scene.index * 100 + v,
    });
    const out = path.join(dir, `${scene.id}-a${scene.attempts + v}.png`);
    await writeBase64File(base64, out);
    scene.variants.push(out);
  }

  // Al regenerar se muestra la candidata mas reciente.
  scene.activeVariant = scene.variants.length - 1;
  scene.attempts += variantCount;

  // Si cambio el texto, la voz grabada ya no corresponde.
  if (opts.regenerateVoice) {
    await synthesizeScene(deps, story, scene);
  }

  scene.status = 'generated';
  return scene;
}

/** Sintetiza la voz de un plano y guarda su duracion real. */
async function synthesizeScene(deps: PipelineDeps, story: Story, scene: Scene): Promise<void> {
  const dir = path.join(deps.storageDir, story.id, 'audio');
  await mkdir(dir, { recursive: true });

  const spoken = TtsProvider.stripSpeakerLabels(scene.narration, story.characters.map((c) => c.name));
  if (!spoken) return;

  // La extension la decide la API: devuelve PCM crudo envuelto en WAV, no MP3.
  const audio = await deps.tts.speak({ text: spoken, locale: story.locale });
  const out = path.join(dir, `${scene.id}.${audio.extension}`);
  await writeBase64File(audio.base64, out);
  scene.audioPath = out;
  scene.targetDuration = await probeDuration(out);
}

async function loadReferences(
  characters: { referenceImagePath?: string }[],
): Promise<{ base64: string; mimeType: string }[]> {
  const refs: { base64: string; mimeType: string }[] = [];
  for (const character of characters) {
    if (!character.referenceImagePath) continue;
    try {
      const buf = await readFile(character.referenceImagePath);
      refs.push({ base64: buf.toString('base64'), mimeType: 'image/png' });
    } catch {
      // Una referencia ausente degrada la consistencia pero no debe tumbar el render.
    }
  }
  return refs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Etapa 3: voz
// ─────────────────────────────────────────────────────────────────────────────

/** Genera la pista de audio de cada plano y guarda su duracion real. */
export async function generateVoice(deps: PipelineDeps, story: Story): Promise<Story> {
  for (const scene of story.scenes) {
    checkStop(deps);
    deps.onProgress?.({
      stage: 'voice', completed: scene.index - 1, total: story.scenes.length,
      status: 'running', message: `Plano ${scene.index}`,
    });

    if (!scene.narration.trim()) {
      scene.targetDuration = 2;
      continue;
    }

    await synthesizeScene(deps, story, scene);
  }

  deps.onProgress?.({ stage: 'voice', completed: story.scenes.length, total: story.scenes.length, status: 'done' });
  return story;
}

// ─────────────────────────────────────────────────────────────────────────────
// Etapa 4 y 5: subtitulos y composicion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construye el ASS de subtitulos y compone el video final.
 *
 * Solo compone planos `approved` cuando `requireApproval` esta activo. Es la
 * barrera que impide publicar material sin revision humana.
 */
export async function composeFinal(
  deps: PipelineDeps,
  story: Story,
  config: StoryConfig,
): Promise<string> {
  const dir = path.join(deps.storageDir, story.id);
  await mkdir(dir, { recursive: true });

  const active = config.requireApproval
    ? story.scenes.filter((s) => s.status === 'approved')
    : story.scenes.filter((s) => s.status !== 'rejected');

  if (active.length === 0) throw new DomainError('No hay planos aprobados para componer.', 'invalid');

  deps.onProgress?.({ stage: 'subtitles', completed: 0, total: 1, status: 'running' });

  // Los tiempos de subtitulo son absolutos sobre la linea de tiempo completa,
  // asi que cada toma arranca donde termino la anterior.
  const cues: CueTiming[] = [];
  const shots: Shot[] = [];
  let cursorMs = 0;

  for (const scene of active) {
    // Se compone la variante elegida, no la ultima generada: es el punto de
    // regenerar "variantes" y descartar las que no sirvieron.
    const imagePath = scene.variants[scene.activeVariant] ?? scene.variants[0];
    if (!imagePath || !scene.audioPath) continue;
    const durationMs = scene.targetDuration * 1000;
    // Los subtitulos se reparten solo sobre el tramo con voz, sin el silencio
    // inicial/final del TTS; el plano completo sigue durando `durationMs`.
    const span = await probeSpeechSpan(scene.audioPath, scene.targetDuration);
    cues.push(
      cuesFromScene(scene.narration, (span.endSec - span.startSec) * 1000, cursorMs + span.startSec * 1000),
    );
    shots.push({ imagePath, audioPath: scene.audioPath, duration: scene.targetDuration });
    cursorMs += durationMs;
  }

  if (shots.length === 0) {
    throw new DomainError('Los planos aprobados no tienen imagen ni audio. Regeneralos antes de renderizar.', 'invalid');
  }

  const subtitlePath = path.join(dir, 'subtitles.ass');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(subtitlePath, buildAss(cues), 'utf8');

  deps.onProgress?.({ stage: 'subtitles', completed: 1, total: 1, status: 'done' });
  deps.onProgress?.({ stage: 'compose', completed: 0, total: 1, status: 'running', message: 'Renderizando' });

  const outputPath = path.join(dir, `${story.id}.mp4`);
  await composeStory(shots, subtitlePath, outputPath, dir, story.musicPath, config.quality);

  // ffmpeg puede terminar con codigo 0 y dejar un archivo vacio si se le corta
  // a mitad, por ejemplo cuando el servidor se reinicia durante el render. Sin
  // esta comprobacion el trabajo se marcaba como completado y el usuario
  // descargaba un MP4 de 0 bytes creyendo que todo estaba bien.
  const { statSync } = await import('node:fs');
  const { rm } = await import('node:fs/promises');
  const bytes = statSync(outputPath).size;

  if (bytes === 0) {
    await rm(outputPath, { force: true });
    throw new DomainError(
      'El render termino sin producir archivo. Vuelve a intentarlo.',
      'invalid',
    );
  }

  const duration = await probeDuration(outputPath);
  if (duration <= 0) {
    await rm(outputPath, { force: true });
    throw new DomainError('El video renderizado esta vacio o corrupto.', 'invalid');
  }

  deps.onProgress?.({ stage: 'compose', completed: 1, total: 1, status: 'done' });
  deps.onProgress?.({
    stage: 'export', completed: 1, total: 1, status: 'done',
    message: `${duration.toFixed(1)}s · ${(bytes / 1024 / 1024).toFixed(1)} MB`,
  });

  return outputPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline completo
// ─────────────────────────────────────────────────────────────────────────────

export interface RunPipelineOptions {
  topic: string;
  /** El usuario pegó un guion que se debe adaptar a planos, no una premisa. */
  isFullScript?: boolean;
  sceneCount?: number;
  styleId?: string;
  tone?: string;
  locale?: string;
  /** Semilla creativa: misma semilla y mismo tema producen el mismo guion. */
  seed?: number;
  /** Semilla de imagen, para hacer reproducibles las variantes. */
  imageSeed?: number;
  /** Cuantas imagenes candidatas generar por plano (1 a 4). */
  variants?: number;
}

/**
 * Ejecuta guion -> imagenes -> voz. Se detiene antes de componer: el usuario
 * tiene que revisar los planos. `composeFinal` se invoca aparte, despues de
 * la curacion.
 */
export async function runDraftPipeline(deps: PipelineDeps, opts: RunPipelineOptions): Promise<Story> {
  const story = await writeScript(deps, {
    topic: opts.topic,
    isFullScript: opts.isFullScript,
    sceneCount: opts.sceneCount,
    styleId: opts.styleId,
    tone: opts.tone,
    locale: opts.locale,
    seed: opts.seed,
  });
  await generateImages(deps, story, { variants: opts.variants, imageSeed: opts.imageSeed });
  await generateVoice(deps, story);
  story.updatedAt = new Date().toISOString();
  return story;
}

// ─────────────────────────────────────────────────────────────────────────────
// Edicion de la estructura
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reordena los planos segun la lista de ids recibida.
 *
 * El `index` se recalcula siempre: los subtitulos y la numeracion de la interfaz
 * dependen de el, y dejar indices sueltos tras un reorden produce subtitulos
 * descolocados respecto a la imagen.
 *
 * Un hook que deja de ser el primero pierde su funcion narrativa: `hook` solo
 * funciona en los tres primeros segundos, asi que al reordenar solo se conserva
 * si sigue estando al principio.
 */
export function reorderScenes(story: Story, orderedIds: string[]): Story {
  const byId = new Map(story.scenes.map((s) => [s.id, s]));

  // Validacion estricta: o llega el conjunto completo de planos, o no se toca
  // nada. Un reorden parcial (id que falta, id repetido) dejaria los indices
  // desalineados con el orden real y los subtitulos se montarian fuera de
  // tiempo sin que nada fallara de forma visible.
  if (orderedIds.length !== story.scenes.length) {
    throw new DomainError('La lista de planos no coincide con los planos de la historia.', 'invalid');
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new DomainError('La lista de planos no coincide con los planos de la historia.', 'invalid');
  }

  const ordered: Scene[] = [];
  for (const id of orderedIds) {
    const scene = byId.get(id);
    if (!scene) throw new DomainError('La lista de planos no coincide con los planos de la historia.', 'invalid');
    ordered.push(scene);
  }

  story.scenes = ordered.map((scene, i) => ({ ...scene, index: i + 1 }));
  return story;
}

/**
 * Duplica un plano justo despues de el.
 *
 * Los ids de archivo se derivan del id del plano, asi que hay que emitir un id
 * nuevo; de lo contrario el duplicado sobrescribiria los artefactos del original.
 * Los candidatos generados hasta ahora se copian: es una copia exacta, no una
 * regeneracion, asi que no debe costar ninguna llamada a la API.
 */
export function duplicateScene(story: Story, sceneId: string): Story {
  const position = story.scenes.findIndex((s) => s.id === sceneId);
  if (position === -1) throw new DomainError(`No existe el plano ${sceneId}`, 'not_found');
  const source = story.scenes[position]!;
  const id = `s${sceneId.slice(1)}-${Date.now().toString(36)}`;

  const copy: Scene = {
    ...source,
    id,
    // El plano nuevo arranca sin aprobar: hay que revisarlo como cualquier otro.
    status: 'generated',
    variants: [...source.variants],
    activeVariant: source.activeVariant,
    // El audio tambien se copia: los tiempos de los subtitulos siguen valiendo.
    audioPath: source.audioPath,
  };

  story.scenes.splice(position + 1, 0, copy);
  story.scenes = story.scenes.map((scene, i) => ({ ...scene, index: i + 1 }));
  return story;
}

/** Elimina un plano y reindexa el resto. */
export function deleteScene(story: Story, sceneId: string): Story {
  const remaining = story.scenes.filter((s) => s.id !== sceneId);

  // Se valida antes de tocar nada. Si se filtrara primero y se comprobara
  // despues, un rechazo dejaria la historia sin su ultimo plano: el error se
  // avisaria, pero el trabajo ya estaria destruido en disco.
  if (remaining.length === story.scenes.length) {
    throw new DomainError(`No existe el plano ${sceneId}`, 'not_found');
  }
  if (remaining.length === 0) {
    throw new DomainError('Una historia necesita al menos un plano.', 'invalid');
  }

  story.scenes = remaining.map((scene, i) => ({ ...scene, index: i + 1 }));
  return story;
}
