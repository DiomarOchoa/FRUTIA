/**
 * Proveedor de voz alternativo: Pollinations.ai.
 *
 * El mismo motivo que el de imagenes. El free tier de Google para texto a voz
 * se agota con facilidad y devuelve `429` aunque la clave sea valida; cuando
 * eso ocurre no se pierde el trabajo ya generado, se cae a este proveedor, que
 * usa la misma clave y devuelve MP3 directamente.
 *
 * Ventaja sobre la voz de Google: el audio llega en MP3, no en PCM crudo, asi
 * que no hay que envolverlo en WAV a mano.
 */

/** Voces disponibles, verificadas una por una contra el servicio. */
export const POLLINATIONS_VOICES = [
  'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer',
] as const;

export type PollinationsVoice = (typeof POLLINATIONS_VOICES)[number];

export interface PollinationsTtsOptions {
  /** Clave secreta. Si falta, se lee POLLINATIONS_API_KEY del entorno. */
  token?: string;
  voice?: PollinationsVoice;
  timeoutMs?: number;
  /** Milisegundos minimos entre llamadas. */
  minIntervalMs?: number;
}

const BASE = 'https://gen.pollinations.ai/audio';

/** Un 429 o 403 significa cuota agotada en Google: toca cambiar de proveedor. */
export function isQuotaError(status: number, body: string): boolean {
  if (status !== 429 && status !== 403) return false;
  return /quota|exceeded|resource_exhausted|rate limit/i.test(body);
}

export class PollinationsTtsProvider {
  private readonly token: string | undefined;
  private readonly voice: PollinationsVoice;
  private readonly timeoutMs: number;
  private lastFreeAt = 0;

  constructor(private readonly opts: PollinationsTtsOptions = {}) {
    this.token = opts.token || process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_TOKEN || undefined;
    const requested = opts.voice ?? (process.env.FRUTIA_VOICE as PollinationsVoice | undefined);
    this.voice = requested && POLLINATIONS_VOICES.includes(requested)
      ? requested
      : 'nova';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async speak(text: string): Promise<{ base64: string; mimeType: string }> {
    if (!this.token) {
      throw new Error('Voz alternativa: falta POLLINATIONS_API_KEY en .env');
    }

    // Separar las llamadas: el servicio tolera rafagas, pero un poco de espaciado
    // evita errores transitorios.
    const gap = (this.opts.minIntervalMs ?? 300) - (Date.now() - this.lastFreeAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    this.lastFreeAt = Date.now();

    // Sin parametro `model`: el endpoint de audio elige su propio motor y
    //Names uno invalido responde 400.
    const url = `${BASE}/${encodeURIComponent(text)}?voice=${this.voice}&key=${this.token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Voz ${res.status}: ${detail.slice(0, 200)}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('Voz alternativa devolvio audio vacio.');

      return {
        base64: buf.toString('base64'),
        mimeType: res.headers.get('content-type') ?? 'audio/mpeg',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}