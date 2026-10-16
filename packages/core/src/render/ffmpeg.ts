/**
 * Composicion de video con ffmpeg.
 *
 * Este es el corazon del modo $0. Sin modelos de video (que no tienen free
 * tier), cada plano se convierte en un clip corto a partir de una imagen
 * estatica usando movimiento de camara tipo Ken Burns, combinado con
 * transiciones y el audio ya generado.
 *
 * Por que funciona: el algoritmo de TikTok no evalua "fotogramas de video
 * reales", evalua retencion. Un encuadre que se mueve con intencion, mas voz
 * dramatica y subtitulo palabra-a-palabra, retiene igual que cualquier otra
 * cosa. El upgrade a video real entra despues por `VideoProvider` sin tocar
 * este archivo.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { QualityTier } from '../types.js';

/**
 * `ffmpeg-static` es un paquete CommonJS que exporta la ruta al binario. Bajo
 * ESM la importacion por defecto no resuelve de forma fiable, asi que se carga
 * con `createRequire`, que si lo hace y ademas evita el interop de `default`.
 */
const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require('ffmpeg-static');

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;
export const FPS = 30;

interface VideoProfile {
  width: number;
  height: number;
  fps: number;
  preset: string;
  crf: number;
}

const VIDEO_PROFILES: Record<QualityTier, VideoProfile> = {
  // Vista previa ligera para revisar guion, voz y ritmo sin esperar un render HD.
  draft: { width: 540, height: 960, fps: 15, preset: 'ultrafast', crf: 25 },
  standard: { width: 720, height: 1280, fps: 24, preset: 'veryfast', crf: 22 },
  hd: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, fps: FPS, preset: 'medium', crf: 20 },
};

/** Duracion maxima (s) del fundido entre planos. */
export const TRANSITION_SEC = 0.3;

/** Formato de un plano ya renderizado a imagen + audio. */
export interface Shot {
  imagePath: string;
  audioPath: string;
  /** Duracion real del audio en segundos. Manda sobre cualquier estimacion. */
  duration: number;
}

/**
 * Como se mueve la camara en cada plano. Se elige en round-robin para que dos
 * planos consecutivos no compartan movimiento: el ojo nota la repeticion antes
 * de que el espectador decida si se queda.
 */
const CAMERA_MOVES = [
  'in',      // zoom lento hacia adentro
  'out',     // zoom lento hacia afuera
  'left',    // paneo a la izquierda
  'right',   // paneo a la derecha
  'up',      // paneo hacia arriba
  'down',    // paneo hacia abajo
] as const;

export type CameraMove = (typeof CAMERA_MOVES)[number];

/**
 * Genera el filtro `zoompan` de un plano.
 *
 * Trampa importante de `zoompan`: su parametro `d` son los fotogramas de SALIDA
 * que produce CADA fotograma de entrada. Como aqui la entrada es una imagen en
 * bucle, ya llegan `duration * FPS` fotogramas; poner `d` al numero total
 * multiplica la duracion por si misma (75 x 75 = 5625 fotogramas, casi tres
 * minutos para un plano de 2,5s). Por eso `d=1` y toda la animacion se deriva
 * de `on`, el indice del fotograma de salida.
 *
 * El movimiento se expresa como funcion de `on / (frames - 1)`, que recorre de
 * 0 a 1 durante el plano. La velocidad es entonces independiente de la
 * duracion: un plano de 2s y uno de 12s hacen el mismo trayecto en su tiempo.
 */
function zoompanFilter(move: CameraMove, durationSec: number, profile: VideoProfile): string {
  const frames = Math.max(2, Math.round(durationSec * profile.fps));
  // `on` va de 0 a frames-1; el divisor evita division por cero.
  const span = frames - 1;

  const ZOOM_FROM = 1.05;
  const ZOOM_TO = 1.28;
  const delta = (ZOOM_TO - ZOOM_FROM).toFixed(4);

  const zoomExpr =
    move === 'in' ? `${ZOOM_FROM}+${delta}*on/${span}` :
    move === 'out' ? `${ZOOM_TO}-${delta}*on/${span}` :
    '1.18';

  // El pan recorre el ancho (o alto) libre que deja el zoom, de un extremo al
  // otro segun el sentido.
  const xExpr =
    move === 'right' ? `(iw-iw/zoom)*(1-on/${span})` :
    move === 'left' ? `(iw-iw/zoom)*on/${span}` :
    'iw/2-(iw/zoom/2)';

  const yExpr =
    move === 'down' ? `(ih-ih/zoom)*on/${span}` :
    move === 'up' ? `(ih-ih/zoom)*(1-on/${span})` :
    'ih/2-(ih/zoom/2)';

  return (
    // Las imágenes de partida ya son pequeñas; ampliarlas a 2x antes de
    // zoompan solo multiplica el coste sin recuperar detalle real.
    `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,` +
    `crop=${profile.width}:${profile.height},` +
    `zoompan=z='${zoomExpr}':d=1:x='${xExpr}':y='${yExpr}':` +
    `s=${profile.width}x${profile.height}:fps=${profile.fps}`
  );
}

/** Normaliza el tamano de la imagen antes de animarla. */
function preScale(profile: VideoProfile): string {
  return (
    `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,` +
    `crop=${profile.width}:${profile.height}`
  );
}

/**
 * Convierte una lista de planos en un unico MP4 de 9:16.
 *
 * Cada plano se procesa como un input independiente y se une con fundidos
 * `xfade` (video) y `concat` (audio). Cada plano lleva su audio, asi que el video ya sale con la
 * pista de voz sincronizada toma a toma.
 */
export async function composeStory(
  shots: Shot[],
  subtitlePath: string | null,
  outputPath: string,
  workDir: string,
  musicPath?: string,
  quality: QualityTier = 'standard',
): Promise<string> {
  if (shots.length === 0) throw new Error('No hay planos que componer.');

  const profile = VIDEO_PROFILES[quality];

  const bin = ffmpegPath;
  if (!bin) throw new Error('ffmpeg-static no resolvio el binario. Revisa la instalacion.');

  await mkdir(workDir, { recursive: true });
  await mkdir(path.dirname(outputPath), { recursive: true });

  const args: string[] = ['-y'];

  // Fundido entre planos (`xfade`). Para no desincronizar voz y subtitulos, cada
  // plano salvo el ultimo se alarga `tr` segundos y el fundido empieza justo en
  // el limite de audio: la suma de duraciones de video sigue igualando a la del
  // audio concatenado.
  const minDur = Math.min(...shots.map((s) => s.duration));
  const tr = shots.length > 1 ? Math.min(TRANSITION_SEC, minDur * 0.4) : 0;
  const extra = (i: number): number => (i < shots.length - 1 ? tr : 0);

  // Un input por plano: imagen en bucle + audio.
  // `-framerate` fija la cadencia del bucle para que la imagen aporte
  // exactamente `dur * FPS` fotogramas y el plano mida lo que dice el audio.
  shots.forEach((shot, i) => {
    args.push('-loop', '1', '-framerate', String(profile.fps), '-t', (shot.duration + extra(i)).toFixed(3), '-i', shot.imagePath);
    args.push('-i', shot.audioPath);
  });
  if (musicPath) args.push('-stream_loop', '-1', '-i', musicPath);

  // Filtro de video por plano: pre-escalado + Ken Burns.
  const videoChains: string[] = [];
  const audioChains: string[] = [];
  shots.forEach((_shot, i) => {
    const imgIdx = i * 2;
    const audIdx = i * 2 + 1;
    const move = CAMERA_MOVES[i % CAMERA_MOVES.length]!;
    const dur = shots[i]!.duration + extra(i);

    videoChains.push(
      `[${imgIdx}:v]${preScale(profile)},${zoompanFilter(move, dur, profile)},setsar=1[v${i}]`,
    );
    audioChains.push(`[${audIdx}:a]aresample=48000,asetpts=N/SR/TB[a${i}]`);
  });

  // Une los videos con xfade (o pasa el unico plano tal cual) y concatena audios.
  const aLabels = shots.map((_, i) => `[a${i}]`).join('');
  const xfades: string[] = [];
  let prev = 'v0';
  let offset = 0;
  for (let i = 1; i < shots.length; i++) {
    offset += shots[i - 1]!.duration;
    const out = i === shots.length - 1 ? 'vcat' : `x${i}`;
    xfades.push(
      `[${prev}][v${i}]xfade=transition=fade:duration=${tr.toFixed(3)}:offset=${offset.toFixed(3)}[${out}]`,
    );
    prev = out;
  }
  if (shots.length === 1) xfades.push('[v0]null[vcat]');
  let filter = `${videoChains.join(';')};${audioChains.join(';')};` +
    `${xfades.join(';')};` +
    `${aLabels}concat=n=${shots.length}:v=0:a=1[acat]`;

  let audioOutput = '[acat]';
  if (musicPath) {
    const musicIdx = shots.length * 2;
    const duration = shots.reduce((sum, shot) => sum + shot.duration, 0);
    filter += `;[${musicIdx}:a]aresample=48000,volume=0.14,atrim=duration=${duration.toFixed(3)},asetpts=N/SR/TB[bg];` +
      '[acat][bg]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]';
    audioOutput = '[aout]';
  }

  // Quema los subtitulos quemandolos sobre el video concatenado.
  if (subtitlePath) {
    const subPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    filter += `;[vcat]ass='${subPath}'[vout];`;
  } else {
    filter += `;[vcat]null[vout];`;
  }

  args.push('-filter_complex', filter);
  args.push('-map', '[vout]', '-map', audioOutput);
  args.push(
    '-c:v', 'libx264',
    '-preset', profile.preset,
    '-crf', String(profile.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  );

  await runFfmpeg(bin, args);
  return outputPath;
}

/**
 * Detecta donde empieza y termina la voz dentro de un audio, descartando el
 * silencio inicial y final que dejan los motores TTS. Los subtitulos se
 * reparten sobre ese tramo y no sobre el archivo entero, que es lo que los
 * desfasaba. Si la deteccion falla, devuelve el audio completo.
 */
export async function probeSpeechSpan(
  audioPath: string,
  totalSec: number,
): Promise<{ startSec: number; endSec: number }> {
  const full = { startSec: 0, endSec: totalSec };
  const bin = ffmpegPath;
  if (!bin) return full;
  try {
    const log = await new Promise<string>((resolve, reject) => {
      const proc: ChildProcessByStdio<null, null, Readable> = spawn(
        bin,
        ['-hide_banner', '-i', audioPath, '-af', 'silencedetect=noise=-35dB:d=0.12', '-f', 'null', '-'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let out = '';
      proc.stderr.on('data', (c: Buffer) => { out += c.toString(); });
      proc.on('error', reject);
      proc.on('close', () => resolve(out));
    });
    const starts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...log.matchAll(/silence_end: (-?[\d.]+)/g)].map((m) => Number(m[1]));
    let startSec = 0;
    let endSec = totalSec;
    // Silencio inicial: arranca en ~0 y termina antes del final.
    if (starts.length > 0 && starts[0]! <= 0.05 && ends.length > 0 && ends[0]! < totalSec) {
      startSec = Math.max(0, ends[0]!);
    }
    // Silencio final: el ultimo silencio llega hasta el final del archivo (sin
    // cierre, o cerrado por ffmpeg en la ultima marca).
    const lastStart = starts[starts.length - 1];
    const lastEnd = ends[ends.length - 1];
    const reachesEnd = starts.length > ends.length || (lastEnd !== undefined && lastEnd >= totalSec - 0.05);
    if (lastStart !== undefined && lastStart > startSec + 0.05 && reachesEnd) {
      endSec = Math.min(totalSec, lastStart);
    }
    return endSec - startSec >= 0.3 ? { startSec, endSec } : full;
  } catch {
    return full;
  }
}

/** Ejecuta ffmpeg y propaga los errores con contexto util. */
function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // Tipamos `proc` explicitamente: la sobrecarga de `spawn` con stdio mixto
    // colapsa a `never` bajo TypeScript 5 sin esta anotacion.
    const proc: ChildProcessByStdio<null, null, Readable> = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      // ffmpeg es muy verboso; solo guardamos el final, que es donde esta el error.
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg termino con codigo ${code}:\n${stderr.slice(-1500)}`));
    });
  });
}

/** Duracion real de un archivo de audio, en segundos. La usa el pipeline. */
export async function probeDuration(audioPath: string): Promise<number> {
  const bin = ffmpegPath;
  if (!bin) throw new Error('ffmpeg-static no resolvio el binario.');
  return new Promise((resolve, reject) => {
    // `ffprobe` no viene con ffmpeg-static: leemos la cabecera de duracion que
    // ffmpeg escribe en stderr al recibir `-i` sin archivo de salida.
    const proc: ChildProcessByStdio<null, null, Readable> = spawn(bin, ['-i', audioPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!match) return reject(new Error(`No se pudo leer la duracion de ${audioPath}`));
      const [, h = '0', m = '0', s = '0'] = match;
      resolve(Number(h) * 3600 + Number(m) * 60 + Number(s));
    });
  });
}

/** Convierte base64 (de la API) a archivo en disco. */
export async function writeBase64File(base64: string, outPath: string): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, Buffer.from(base64, 'base64'));
  return outPath;
}
