/**
 * Modelo de dominio de Frutia.
 *
 * La unidad central es el `Story` (frutinovela): un guion dividido en `Scene`
 * (planos), cada uno con su narracion, sus personajes y su imagen. La
 * consistencia entre planos se sostiene por `characterIds`, que permite recuperar
 * la imagen de referencia del personaje y reinyectarla al generar cada toma.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Personajes
// ─────────────────────────────────────────────────────────────────────────────

/** Fruta u objeto protagonista. El arquetipo manda el diseño visual. */
export type Archetype =
  | 'villain'   // la traidora, la manipuladora
  | 'hero'      // la victima / protagonista
  | 'naive'     // la ingenua, la confiada
  | 'rival'     // competencia directa
  | 'bestie'    // la confidente, la que aconseja
  | 'boss';     // la jefa, la que manda

export interface Character {
  id: string;
  /** Nombre propio, por ejemplo "Margarita". */
  name: string;
  /** Tipo de fruta u objeto, por ejemplo "fresa". Sustantivo en minuscula. */
  species: string;
  archetype: Archetype;
  /**
   * Descripcion visual fija y reutilizable. Es lo que mantiene la consistencia
   * del personaje entre planos: nunca se reescribe una vez aprobada.
   */
  visualDescription: string;
  /** Tono de voz para el TTS, por ejemplo "femenina-ansiosa" o "masculina-grave". */
  voiceTone: string;
  /** Personalidad en una frase, para que el guion tenga voz propia. */
  personality: string;
  /** Ruta de la imagen de referencia. Se llena tras el primer render. */
  referenceImagePath?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guion y planos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Funcion narrativa de un plano dentro del arco de la historia.
 * La plantilla de guion fuerza la secuencia
 * hook -> setup -> conflict -> escalation -> turn -> cliffhanger,
 * porque es la estructura que sostiene la retencion en TikTok.
 */
export type SceneRole =
  | 'hook'        // primeros 3s: la pregunta que impide dejar de deslizar
  | 'setup'       // presentar a los personajes
  | 'conflict'    // el detonante
  | 'escalation'  // las fuerzas suben
  | 'turn'        // el giro inesperado
  | 'cliffhanger' // el cierre que obliga a ver la parte 2
  | 'cta';        // llamada a la accion o marca

export interface Scene {
  id: string;
  /** Posicion en el guion, base 1, para leerlo y editarlo como una lista. */
  index: number;
  role: SceneRole;
  /** Texto narrado en voz alta. Es la base de los subtitulos. */
  narration: string;
  /** Descripcion de la toma, en una frase, en espanol. */
  shotDescription: string;
  /** IDs de los personajes visibles. Decide que referencias se inyectan. */
  characterIds: string[];
  /** Duracion objetivo en segundos. El TTS puede ajustarla. */
  targetDuration: number;
  /**
   * Imagenes candidatas del plano. La generacion por variantes produce varias
   * de una sentada y el usuario elige: es mas barato que regenerar la historia
   * entera cuando solo una toma queda mal.
   */
  variants: string[];
  /** Indice dentro de `variants` de la imagen en uso. */
  activeVariant: number;
  /** Cuantas veces se ha regenerado el plano. Se muestra en la interfaz. */
  attempts: number;
  /** Artefactos generados para este plano. */
  audioPath?: string;
  status: SceneStatus;
}

/**
 * Ninguna escena se renderiza sin pasar por `approved`. Este enum es la
 * maquina que sostiene la politica de curaduria humana declarada en el README.
 */
export type SceneStatus =
  | 'draft'      // el LLM lo escribio
  | 'generated'  // ya tiene imagen y audio
  | 'approved'   // un humano lo aprobo: apto para exportar
  | 'rejected';  // el humano lo descarto

export interface Story {
  id: string;
  title: string;
  /** Premisa de una linea, por ejemplo "La fresa descubrio que su novio es una ciruela". */
  premise: string;
  characters: Character[];
  scenes: Scene[];
  /** Id del estilo visual elegido, por ejemplo "pixelart". Permite regenerar tomas. */
  visualStyleId: string;
  /** Prompt visual ya expandido, el que se concatena al prompt de imagen. */
  visualStyle: string;
  /** Tono de la narracion: "melodramatico", "comedia negra", "suspenso". */
  tone: string;
  /** Idioma elegido para el guion y la narración. */
  locale?: string;
  /** Pista musical subida por el usuario para mezclarla bajo las voces. */
  musicPath?: string;
  /** MP4 local de vista previa o exportación final, si ya se renderizó. */
  videoPath?: string;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuracion de generacion
// ─────────────────────────────────────────────────────────────────────────────

export type QualityTier = 'draft' | 'standard' | 'hd';

export interface StoryConfig {
  /** Semilla del guion: la misma semilla mas el mismo tema da el mismo guion. */
  seed?: number;
  /**
   * Semilla de imagen. Misma semilla y mismo prompt dan la misma imagen, lo
   * que hace reproducibles las variantes y permite recuperar una toma concreta.
   */
  imageSeed?: number;
  /**
   * Duracion objetivo total en segundos. Sesenta o mas es el umbral de
   * Creator Rewards, asi que ese es el valor por defecto.
   */
  targetDuration?: number;
  quality: QualityTier;
  /** Idioma y mercado del guion. "es-419" para Latinoamerica. */
  locale?: string;
  /** Si es true, exige aprobacion humana de cada plano antes de exportar. */
  requireApproval?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────

export type RenderStatus = 'queued' | 'running' | 'done' | 'failed';

export interface RenderJob {
  id: string;
  storyId: string;
  status: RenderStatus;
  progress: number;
  outputPath?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progreso del pipeline
// ─────────────────────────────────────────────────────────────────────────────

/** Etapas en orden. La UI las muestra como barra de progreso. */
export type PipelineStage =
  | 'script'     // guion y hoja de personaje
  | 'images'     // una imagen por plano
  | 'voice'      // audio TTS por plano
  | 'subtitles'  // alineacion
  | 'compose'    // render con ffmpeg
  | 'export';

/**
 * Error de dominio con una intencion de codigo HTTP.
 *
 * El nucleo no conoce HTTP, pero si sabe distinguir "no existe" de "la peticion
 * no tiene sentido". Escribir un `Error` a secas obligaba a la API a devolver
 * 500 para casos que claramente son 404 o 400, lo que escondia errores reales
 * de cliente detras de un fallo de servidor.
 */
export class DomainError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'invalid') {
    super(message);
    this.name = 'DomainError';
  }
}

export interface StageProgress {
  stage: PipelineStage;
  completed: number;
  total: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  message?: string;
}
