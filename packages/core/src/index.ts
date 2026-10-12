/**
 * Punto de entrada publico del paquete `@frutia/core`.
 *
 * Todo lo que consumen la API y el worker se reexporta desde aqui, de modo que
 * el pipeline se puede importar igual desde Node que desde la web.
 */

export * from './types.js';
export * from './prompts.js';
export * from './ideas.js';
export * from './providers/llm.js';
export * from './providers/image.js';
export * from './providers/tts.js';
export * from './render/subtitles.js';
export * from './render/ffmpeg.js';
export * from './pipeline.js';