/**
 * Proveedor de imagenes con cascada entre proveedores.
 *
 * El free tier de Google para imagenes es el punto fragil del modo local.
 * Cuando agota cuota, el modo automatico cae a Pollinations, que requiere una
 * clave de servidor y saldo de Pollen en la cuenta.
 *
 * Solo se degrada por falta de cuota. Un error de contenido o de red se
 * propaga: cambiar de proveedor a ciegas no lo arregla y gasta el doble.
 */

import { PollinationsImageProvider } from './image-pollinations.js';
import { HuggingFaceImageProvider } from './image-huggingface.js';
import { ComfyUiImageProvider } from './comfyui.js';
import { isModelRetired, ModelRetiredError, modelCandidates, withModelFallback } from './models.js';
import type { GenerateImageInput, GenerateImageOutput } from './image-types.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiOptions {
  apiKey: string;
  models?: string[];
  timeoutMs?: number;
}

export type ImageProviderPreference = 'auto' | 'gemini' | 'pollinations' | 'comfyui' | 'huggingface';

export interface ResilientImageOptions {
  apiKey: string;
  /**
   * Proveedor preferido: "auto" (por defecto) cae a Pollinations si Google
   * agota cuota, "gemini" falla y "pollinations" usa solo Pollinations.
   */
  prefer?: ImageProviderPreference;
  pollinationsModel?: string;
  /**
   * Ajustes de Pollinations: sobre todo `minIntervalSec`.
   *
   * Existe para poder ajustar el ritmo en pruebas y evitar rafagas.
   */
  pollinations?: { minIntervalSec?: number; model?: string; token?: string };
}

/** Un 429 con este texto significa cuota agotada, no contenido invalido. */
function isQuotaExhausted(status: number, body: string): boolean {
  if (status !== 429 && status !== 403) return false;
  return /quota|exceeded|resource_exhausted|rate limit/i.test(body);
}

class GeminiImageProvider {
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor(private readonly opts: GeminiOptions) {
    if (!opts.apiKey) throw new Error('Imagen: falta GEMINI_API_KEY.');
    this.models = opts.models?.length
      ? opts.models
      : modelCandidates('FRUTIA_IMAGE_MODEL', [
          'gemini-3.1-flash-image',
          'gemini-3-pro-image',
          'gemini-3.1-flash-lite-image',
        ]);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async generate(input: GenerateImageInput): Promise<GenerateImageOutput> {
    return withModelFallback(this.models, (model) => this.call(model, input));
  }

  private async call(model: string, input: GenerateImageInput): Promise<GenerateImageOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const parts: { text?: string; inline_data?: { mime_type: string; data: string } }[] = [
        { text: input.prompt },
      ];
      for (const ref of input.referenceImages ?? []) {
        parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.base64 } });
      }

      const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] };
      if (input.seed !== undefined) {
        generationConfig.seed = input.seed;
        // Con temperatura baja las candidatas salen casi identicas y "elegir
        // la mejor" deja de tener sentido.
        generationConfig.temperature = 0.95;
      }

      const res = await fetch(
        `${BASE}/models/${model}:generateContent?key=${encodeURIComponent(this.opts.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
        },
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (isModelRetired(res.status, detail)) {
          throw new ModelRetiredError(`Imagen ${res.status}: ${detail.slice(0, 300)}`);
        }
        if (isQuotaExhausted(res.status, detail)) {
          throw new QuotaExhaustedError(`Imagen ${res.status}: ${detail.slice(0, 200)}`);
        }
        throw new Error(`Imagen ${res.status}: ${detail.slice(0, 300)}`);
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] } }[];
      };
      const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!inline?.data) throw new Error('Imagen: la respuesta no contenia datos de imagen.');
      return { base64: inline.data, mimeType: inline.mimeType ?? 'image/png' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Senal interna: la cuota de imagenes se agoto, toca cambiar de proveedor. */
class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}

/**
 * Proveedor que elige backend en tiempo de ejecucion.
 *
 * Expone el mismo contrato que los proveedores individuales, de modo que el
 * pipeline no sabe (ni necesita saber) contra quien se esta generando.
 */
export class ImageProvider {
  private readonly gemini: GeminiImageProvider | undefined;
  private readonly pollinations: PollinationsImageProvider;
  private readonly comfyui: ComfyUiImageProvider | undefined;
  private readonly huggingface: HuggingFaceImageProvider | undefined;
  private readonly prefer: ImageProviderPreference;

  /**
   * Momento en que Google vuelve a servir, si se pudo calcular.
   *
   * Es la pieza que faltaba y era la causa de que una frutinovela tardara
   * media hora sin producir nada. El free tier de Gemini da 20 peticiones al
   * dia y devuelve `429 quota exceeded` para el resto del dia. Como la cascada
   * probaba Google al principio de CADA imagen, y cada intento recorre tres
   * modelos, cada imagen gastaba tres llamadas fallidas antes de llegar a
   * Pollinations. Con trece imagenes son treinta y nueve llamadas que no
   * podían salir, cada una con su latencia.
   *
   * Guardando el momento del reinicio, la app deja de preguntar a Google hasta
   * que la cuota vuelva de verdad y pasa a los respaldos configurados.
   */
  private geminiMuertoHasta = 0;
  private motivoGemini = '';

  /** Modelo realmente usado en la ultima llamada. Se muestra en la UI. */
  lastBackend = 'gemini';

  /** Pollinations solo acepta texto; no se deben generar referencias inútiles. */
  get supportsReferenceImages(): boolean {
    // ComfyUI tampoco consume referencias visuales en este workflow. Pedir
    // hojas de personaje aquí añadía una generación local cara que se tiraba.
    return this.prefer !== 'pollinations' && this.prefer !== 'huggingface' && this.prefer !== 'comfyui';
  }

  /** Con token Pollinations admite varias generaciones simultáneas. */
  get recommendedConcurrency(): number {
    if (this.prefer === 'huggingface') return 2;
    return this.prefer === 'pollinations' && this.pollinations.hasToken ? 3 : 1;
  }

  constructor(opts: ResilientImageOptions) {
    this.prefer = opts.prefer ?? 'auto';
    this.comfyui = opts.prefer === 'comfyui' ? new ComfyUiImageProvider() : undefined;
    const hfToken = (process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '').replace(/^\uFEFF/, '').trim();
    this.huggingface = opts.prefer === 'huggingface' || (opts.prefer === 'auto' && Boolean(hfToken))
      ? new HuggingFaceImageProvider({ token: hfToken || undefined })
      : undefined;
    // Auto también funciona si Google no está configurado: usa HF o
    // Pollinations cuando esas credenciales sí están disponibles.
    this.gemini = opts.prefer === 'pollinations' || opts.prefer === 'comfyui' || !opts.apiKey
      ? undefined
      : new GeminiImageProvider({ apiKey: opts.apiKey });
    if (opts.prefer === 'gemini' && !this.gemini) throw new Error('Imagen: falta GEMINI_API_KEY.');
    this.pollinations = new PollinationsImageProvider({
      model: opts.pollinations?.model ?? opts.pollinationsModel,
      minIntervalSec: opts.pollinations?.minIntervalSec,
      token: opts.pollinations?.token,
    });
  }

  /**
   * Si Google sigue sin cuota, segun el reloj.
   *
   * Google devuelve el tiempo que falta en el cuerpo del 429 ("Please retry in
   * 14h31m13s"). Cuando lo da se respeta; cuando no, se descarta Google por el
   * resto del proceso, que es mejor que insistirse cada imagen.
   */
  private geminiDisponible(): boolean {
    if (Date.now() >= this.geminiMuertoHasta) return true;

    if (this.motivoGemini) {
      const mins = Math.ceil((this.geminiMuertoHasta - Date.now()) / 60_000);
      Object.defineProperty(this, 'degradedReason', {
        value: this.motivoGemini, writable: true, configurable: true,
      });
    }
    return false;
  }

  /** Calcula cuando vuelve la cuota a partir del texto del 429 de Google. */
  private registrarMuerteGemini(mensaje: string): void {
    const espera = mensaje.match(/retry in ([\dhms.]+)/i)?.[1];
    const segundos = espera ? this.enSegundos(espera) : null;

    this.geminiMuertoHasta = segundos
      ? Date.now() + segundos * 1000
      : Number.POSITIVE_INFINITY;

    this.motivoGemini = segundos
      ? `Google sin cuota de imágenes; se reintenta en ${Math.round(segundos / 3600)} h. Frutia probará los respaldos configurados.`
      : 'Google quedó sin cuota de imágenes en esta sesión. Frutia probará los respaldos configurados.';
  }

  /** Convierte "14h31m13.5s" a segundos. */
  private enSegundos(texto: string): number | null {
    let total = 0;
    let encontro = false;

    for (const [, valor = '', unidad = ''] of texto.matchAll(/(\d+(?:\.\d+)?)([hms])/gi)) {
      const n = Number(valor);
      const u = unidad.toLowerCase();
      total += u === 'h' ? n * 3600 : u === 'm' ? n * 60 : n;
      encontro = true;
    }

    return encontro ? total : null;
  }

  async generate(input: GenerateImageInput): Promise<GenerateImageOutput> {
    if (this.prefer === 'huggingface') {
      this.lastBackend = 'huggingface';
      return this.huggingface!.generate(input);
    }

    if (this.prefer === 'comfyui') {
      this.lastBackend = 'comfyui';
      return this.comfyui!.generate(input);
    }

    if (this.prefer === 'pollinations') {
      this.lastBackend = 'pollinations';
      return this.pollinations.generate(input);
    }

    if (this.prefer === 'gemini') {
      this.lastBackend = 'gemini';
      return this.gemini!.generate(input);
    }

    return this.generateAutomatic(input);
  }

  /** Recorre los motores configurados sin pedir al usuario que los cambie. */
  private async generateAutomatic(input: GenerateImageInput): Promise<GenerateImageOutput> {
    if (this.gemini && this.geminiDisponible()) {
      try {
        const result = await this.gemini.generate(input);
        this.lastBackend = 'gemini';
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const quotaGone = error instanceof QuotaExhaustedError || /429|quota/i.test(message);
        if (!quotaGone) throw error;
        this.registrarMuerteGemini(message);
      }
    }

    const fallos: string[] = [];
    if (this.huggingface) {
      try {
        const result = await this.huggingface.generate(input);
        this.lastBackend = 'huggingface';
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fallos.push(`Hugging Face: ${message}`);
        // No reintentar errores de prompt: solo pasar a otro backend cuando
        // parece ser una caída, cuota, autenticación o modelo no disponible.
        if (!/401|402|403|404|408|429|5\d\d|timeout|timed out|temporar|unavailable|provider/i.test(message)) {
          throw error;
        }
      }
    }

    this.lastBackend = 'pollinations';
    try {
      const result = await this.pollinations.generate(input);
      Object.defineProperty(this, 'degradedReason', {
        value: this.motivoGemini || fallos.join(' · '), writable: true, configurable: true,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (fallos.length) throw new Error(`${fallos.join(' · ')} · ${message}`);
      throw error;
    }
  }
}
