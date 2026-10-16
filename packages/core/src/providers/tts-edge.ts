/**
 * Motor de voz gratuito basado en las voces neuronales de Microsoft Edge.
 *
 * Existe por un motivo concreto: los otros dos motores tienen cuota de pago.
 * Google devuelve 429 al agotarse el free tier y Pollinations responde 402 sin
 * saldo de Pollen. Entre los dos dejaban la app sin voz, y la voz es
 * obligatoria: sin ella no hay video.
 *
 * Edge no pide clave, ni tarjeta, ni registro. Es el mismo servicio que usa un
 * navegador para leer paginas en voz alta, asi que funciona sin cuenta.
 *
 * LIMITACION QUE DEBES CONOCER
 *
 * Es un servicio gratuito sin contrato de API. Microsoft puede cambiarlo o
 * pedir captcha sin avisar. Conviene tratarlo como el respaldo que es, no como
 * la base sobre la que construir un negocio de pago. Si empieza a fallar, la
 * solucion es una clave de Google con facturacion, no reintentar.
 */

/**
 * El paquete `edge-tts` declara `"main": "index.ts"`, o sea su codigo fuente.
 * Node no procesa TypeScript dentro de node_modules y falla con
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, asi que se importa la version
 * ya compilada de `out/`, que es lo que el paquete publica de verdad.
 */
import { tts, getVoices } from 'edge-tts/out/index.js';

export interface EdgeTtsOptions {
  /** Voz de Edge, con el formato es-CO-AndreaNeural. */
  voice?: string;
  /** Ritmo. +10% es algo mas animado sin arrastrar. */
  rate?: string;
}

/**
 * Voces en espanol verificadas en Edge.
 *
 * Las de Colombia van primero porque el contenido es principalmente
 * supporteano: `Andrea` es la narradora por defecto y `Gonzalo` encaja con un
 * personaje masculino.
 */
export const EDGE_VOICES = {
  andrea: 'es-CO-AndreaNeural',
  gonzalo: 'es-CO-GonzaloNeural',
  dalia: 'es-MX-DaliaNeural',
  juan: 'es-MX-JuanNeural',
  elvira: 'es-ES-ElviraNeural',
} as const;

export type EdgeVoice = (typeof EDGE_VOICES)[keyof typeof EDGE_VOICES];

export class EdgeTtsProvider {
  private readonly voice: EdgeVoice;
  private readonly rate: string;
  private static voicesPromise: ReturnType<typeof getVoices> | undefined;

  constructor(opts: EdgeTtsOptions = {}) {
    const requested = (opts.voice ?? process.env.FRUTIA_EDGE_VOICE) as EdgeVoice | undefined;
    this.voice = requested && Object.values(EDGE_VOICES).includes(requested)
      ? requested
      : EDGE_VOICES.andrea;
    this.rate = opts.rate ?? '+8%';
  }

  async speak(text: string, locale = 'es-419'): Promise<{ base64: string; mimeType: string }> {
    if (!text.trim()) throw new Error('Edge TTS: texto vacio.');

    const voice = await this.voiceForLocale(locale);
    const audio = await tts(text, { voice, rate: this.rate });
    if (!audio || audio.length === 0) {
      throw new Error('Edge TTS devolvio audio vacio.');
    }

    // El paquete pide MP3 y entrega MP3, asi que no hace falta envolver nada
    // como en el caso de Gemini, que devuelve PCM crudo.
    return { base64: audio.toString('base64'), mimeType: 'audio/mpeg' };
  }

  /** Voces disponibles. Sirve para diagnosticar si el servicio responde. */
  static async listVoices(locale = 'es'): Promise<string[]> {
    const todas = await getVoices();
    return todas.filter((v) => v.ShortName.startsWith(locale)).map((v) => v.ShortName);
  }

  private async voiceForLocale(locale: string): Promise<string> {
    const normalized = locale.toLowerCase();
    // Edge mantiene etiquetas por país: español latinoamericano apunta a
    // Colombia y las selecciones explícitas conservan su variante regional.
    const prefix = normalized.startsWith('es-419') ? 'es-' : `${normalized}-`;
    if (normalized.startsWith('es-') && !normalized.startsWith('es-419')) return this.voice;

    try {
      EdgeTtsProvider.voicesPromise ??= getVoices();
      const voices = await EdgeTtsProvider.voicesPromise;
      const choices = voices.filter((voice) => voice.ShortName.toLowerCase().startsWith(prefix));
      if (!choices.length) return this.voice;

      const preferred = normalized.startsWith('es-419') ? 'es-CO-AndreaNeural'
        : normalized.startsWith('pt-br') ? 'pt-BR-FranciscaNeural'
          : normalized.startsWith('en-us') ? 'en-US-AriaNeural' : undefined;
      return choices.find((voice) => voice.ShortName === preferred)?.ShortName
        ?? choices.find((voice) => voice.ShortName.endsWith('Neural'))?.ShortName
        ?? choices.at(0)?.ShortName
        ?? this.voice;
    } catch {
      return this.voice;
    }
  }
}
