/**
 * Proveedor de voz (texto a habla) en espanol.
 *
 * Usa `gemini-2.5-flash-preview-tts`, que tiene free tier (unos 100k caracteres
 * al mes segun la documentacion) y devuelve MP3 listo para ffmpeg. Es la pieza
 * que hace que una frutinovela funcione: el drama necesita una voz con
 * personality, no un TTS robotico plano.
 *
 * El motor divide la narracion en turnos por el formato `PERSONAJE: texto` que
 * exige el prompt de guion, y asigna una voz distinta a cada personaje. Eso
 * refuerza la percepcion de "elenco" sin necesidad de multiples llamadas.
 */

import { isModelRetired, ModelRetiredError, modelCandidates, withModelFallback } from './models.js';
import { isQuotaError, PollinationsTtsProvider, POLLINATIONS_VOICES, type PollinationsVoice } from './tts-pollinations.js';
import { EdgeTtsProvider } from './tts-edge.js';
import { PiperTtsProvider } from './tts-piper.js';

export { POLLINATIONS_VOICES } from './tts-pollinations.js';
export { EDGE_VOICES } from './tts-edge.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** ¿Hay clave de Google disponible? */
function opts_hasKey(opts: TtsOptions): boolean {
  return Boolean(opts.apiKey);
}

/** Error de HTTP con su codigo, para poder decidir la degradacion. */
class StatusLikeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'StatusLikeError';
  }
}

/**
 * Voces predefinidas de Gemini.
 *
 * Ojo: los nombres con formato `es-ES-Neural2-A` son de Azure y **no** existen
 * en Gemini. Pasarlos devuelve un error en el momento de sintetizar, mucho
 * despues de haber gastado la cuota del guion y de las imagenes.
 */
export const GEMINI_VOICES = [
  'Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome',
  'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar',
  'Gacrux', 'Pulcherrima', 'Achird', 'Vindemiatrix', 'Sadaltager', 'Sulafat',
] as const;

export interface TtsOptions {
  apiKey: string;
  /** Sobrescribe la lista de candidatos. */
  models?: string[];
  timeoutMs?: number;
  /** Voz por defecto cuando la pista es narración y no diálogo. */
  defaultVoice?: string;
}

export interface SpeakInput {
  /** Texto completo del plano, con la marca `PERSONAJE: texto` incluida. */
  text: string;
  /** Voz del personaje a quien se le atribuye la narración sin marca. */
  narratorVoice?: string;
}

/** Audio listo para guardarse en disco. */
export interface SpokenAudio {
  base64: string;
  mimeType: string;
  /** Extension del archivo, sin punto. */
  extension: string;
}

/**
 * Envuelve PCM crudo en un contenedor WAV.
 *
 * El modelo de TTS devuelve `audio/l16; rate=24000; channels=1`, que son
 * muestras s16le **sin cabecera**. Guardar eso con extension `.mp3` produce un
 * archivo que ffmpeg no puede leer: el render falla despues de haber gastado
 * toda la cuota del guion y de las imagenes. Envolverlo aqui deja un WAV
 * normal que cualquier herramienta abre.
 */
export function pcmToWav(pcmBase64: string, sampleRate = 24000, channels = 1): string {
  const pcm = Buffer.from(pcmBase64, 'base64');
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4); // tamaño total - 8
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);            // tamaño del bloque fmt
  header.writeUInt16LE(1, 20);             // PCM sin comprimir
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32);  // alineacion de bloque
  header.writeUInt16LE(16, 34);            // bits por muestra
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]).toString('base64');
}

/** Traduce el mimeType que devuelve la API al formato que se guarda en disco. */
export function normalizeAudio(mimeType: string | undefined, dataBase64: string): SpokenAudio {
  const mime = mimeType ?? 'audio/mpeg';
  // La API responde `audio/L16` con L mayuscula y los parametros pueden venir
  // sin el literal "pcm", asi que la comparacion es insensible a mayusculas y
  // no depende de una palabra concreta del mimeType.
  const lower = mime.toLowerCase();

  if (lower.includes('l16') || lower.includes('pcm')) {
    const rate = Number(/rate=(\d+)/.exec(lower)?.[1] ?? 24_000);
    const channels = Number(/channels=(\d+)/.exec(lower)?.[1] ?? 1);
    return {
      base64: pcmToWav(dataBase64, rate, channels),
      mimeType: 'audio/wav',
      extension: 'wav',
    };
  }

  // Si la API devolviera WAV con su propia cabecera, no hay que envolverlo.
  if (lower.includes('wav')) {
    return { base64: dataBase64, mimeType: 'audio/wav', extension: 'wav' };
  }

  return { base64: dataBase64, mimeType: mime, extension: 'mp3' };
}

export class TtsProvider {
  private readonly models: string[];
  private readonly timeoutMs: number;
  private readonly defaultVoice: string;
  private readonly fallback: PollinationsTtsProvider | undefined;
  private readonly edge: EdgeTtsProvider | undefined;
  private readonly piper: PiperTtsProvider;

  /** Motor que sirvio la ultima peticion. Se muestra en la interfaz. */
  lastBackend: 'gemini' | 'pollinations' | 'edge' | 'piper' = 'gemini';

  constructor(private readonly opts: TtsOptions) {
    // Cascada de cuatro motores. Google es el mejor; Pollinations cubre su
    // cuota agotada; Edge queda como red intermedia aunque hoy Microsoft lo
    // bloquea fuera del navegador; Piper es local y por eso la app nunca se
    // queda muda, ni con la red caida.
    this.fallback = (process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_TOKEN)
      ? new PollinationsTtsProvider()
      : undefined;

    // Se puede apagar con EDGE_TTS=0 si algun dia Edge deja de servir.
    this.edge = process.env.EDGE_TTS === '0' ? undefined : new EdgeTtsProvider();

    this.piper = new PiperTtsProvider();

    if (!opts.apiKey && !this.fallback && !this.piper.available) {
      throw new Error('Voz: no hay ningun motor disponible.');
    }

    this.models = opts.models?.length
      ? opts.models
      : modelCandidates('FRUTIA_TTS_MODEL', [
          'gemini-3.1-flash-tts-preview',
          'gemini-2.5-flash-preview-tts',
        ]);
    this.timeoutMs = opts.timeoutMs ?? 60_000;

    const requested = opts.defaultVoice ?? 'Puck';
    if (!GEMINI_VOICES.includes(requested as (typeof GEMINI_VOICES)[number])) {
      throw new Error(
        `Voz "${requested}" no existe en Gemini. Validas: ${GEMINI_VOICES.join(', ')}.`,
      );
    }
    this.defaultVoice = requested;
  }

  /**
   * Sintetiza la pista de voz.
   *
   * Cascada de tres motores, en orden de calidad:
   *
   *   1. Google   -> mejor naturalidad, pero se agota (429)
   *   2. Pollinations -> voz de pago, falla sin saldo (402)
   *   3. Edge    -> sin clave ni cuota, siempre disponible
   *
   * Solo se degrada por cuota o saldo. Un error de texto o de red no se
   * arregla cambiando de motor, asi que en ese caso el error sube: el usuario
   * necesita saber que fallo de verdad, no un audio de otra cosa.
   */
  async speak(input: SpeakInput): Promise<SpokenAudio> {
    if (process.env.FRUTIA_TTS_PROVIDER === 'piper') {
      if (!this.piper.available) throw new Error('Piper fue seleccionado, pero no se encontro el modelo configurado.');
      const audio = await this.piper.speak(input.text);
      this.lastBackend = 'piper';
      return normalizeAudio(audio.mimeType, audio.base64);
    }
    const fallos: string[] = [];

    // 1. Google
    if (opts_hasKey(this.opts)) {
      try {
        const audio = await withModelFallback(this.models, (model) => this.call(model, input));
        this.lastBackend = 'gemini';
        return audio;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fallos.push(`gemini: ${message.slice(0, 120)}`);
        const status = error instanceof StatusLikeError ? error.status : 0;

        // Un 400 de texto o un error de red no se arregla con otro motor.
        if (!isQuotaError(status, message) && !isModelRetired(status, message)) throw error;
      }
    }

    // 2. Pollinations
    if (this.fallback) {
      try {
        const audio = await this.fallback.speak(input.text);
        this.lastBackend = 'pollinations';
        return normalizeAudio(audio.mimeType, audio.base64);
      } catch (error) {
        fallos.push(`pollinations: ${error instanceof Error ? error.message : String(error)}`.slice(0, 140));
      }
    }

    // 3. Edge: red intermedia sin claves ni cuota.
    if (this.edge) {
      try {
        const audio = await this.edge.speak(input.text);
        this.lastBackend = 'edge';
        return normalizeAudio(audio.mimeType, audio.base64);
      } catch (error) {
        fallos.push(`edge: ${error instanceof Error ? error.message : String(error)}`.slice(0, 140));
      }
    }

    // 4. Piper: local, gratis y sin limite. Es el que garantiza que siempre
    // haya voz, aunque los tres servicios externos esten caidos.
    if (this.piper.available) {
      try {
        const audio = await this.piper.speak(input.text);
        this.lastBackend = 'piper';
        return normalizeAudio(audio.mimeType, audio.base64);
      } catch (error) {
        fallos.push(`piper: ${error instanceof Error ? error.message : String(error)}`.slice(0, 140));
      }
    }

    throw new Error(`Voz: fallaron todos los motores.\n${fallos.join('\n')}`);
  }

  private async call(model: string, input: SpeakInput): Promise<SpokenAudio> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(
        `${BASE}/models/${model}:generateContent?key=${encodeURIComponent(this.opts.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: input.text }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: input.narratorVoice ?? this.defaultVoice },
                },
              },
            },
          }),
        },
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (isModelRetired(res.status, detail)) {
          throw new ModelRetiredError(`Voz ${res.status}: ${detail.slice(0, 300)}`);
        }
        throw new StatusLikeError(res.status, `Voz ${res.status}: ${detail.slice(0, 300)}`);
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] } }[];
      };
      const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!inline?.data) throw new Error('Voz: la respuesta no contenia audio.');
      return normalizeAudio(inline.mimeType, inline.data);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Limpia las marcas `PERSONAJE:` que el guion usa para separar turnos.
   *
   * No se usa voz multi-habla: el free tier no la expone de forma fiable y
   * complica el control de ritmo. En su lugar el nombre se retira del texto
   * hablado, y el capitalized de cada nombre (que el LLM ya escribe asi)
   * funciona como una pausa dramatica natural entre turnos.
   */
  static stripSpeakerLabels(text: string, castNames: string[]): string {
    if (castNames.length === 0) return text;
    const pattern = new RegExp(
      `(^|\\n)\\s*(?:${castNames.map(escapeRegex).join('|')})\\s*:\\s*`,
      'gi',
    );
    return text.replace(pattern, (_m, nl: string) => `${nl}\n`).replace(/\n{2,}/g, '\n').trim();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}