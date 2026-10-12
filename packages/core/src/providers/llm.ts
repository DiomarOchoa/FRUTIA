/**
 * Proveedor de texto (LLM) para generar el guion y la hoja de personaje.
 *
 * Se habla directamente con la API de Gemini por `fetch` en lugar de usar el
 * SDK: el pipeline ya es asincrono y encadenado, y Evitar una dependencia mas
 * mantiene el bundle del worker pequeno. El resto del proyecto lo compila a
 * `dist/` con ESM nativo.
 */

import { isModelRetired, ModelRetiredError, modelCandidates, withModelFallback } from './models.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface LlmOptions {
  apiKey: string;
  /** Sobrescribe la lista de candidatos. */
  models?: string[];
  timeoutMs?: number;
}

/**
 * Tiempo maximo por llamada.
 *
 * Se mide que una peticion trivial ("di listo") tardo 40 segundos en un dia
 * normal, y el guion completo son varios miles de tokens. Con 60s el pipeline
 * fallaba de forma intermitente y sin explicacion clara. Con 150s hay margen
 * para el peor caso medido sin dejar la interfaz colgada si el servicio cae.
 */
const DEFAULT_TIMEOUT_MS = 150_000;

export class LlmProvider {
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor(private readonly opts: LlmOptions) {
    if (!opts.apiKey) throw new Error('LLM: falta GEMINI_API_KEY.');
    this.models = opts.models?.length
      ? opts.models
      : modelCandidates('FRUTIA_LLM_MODEL', [
          'gemini-3.8-flash',
          'gemini-3.7-flash',
          'gemini-3.5-flash',
        ]);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Genera texto plano siguiendo un par de instrucciones.
   * Devuelve el contenido crudo, sin interpretar: el parseo vive en prompts.ts.
   */
  async complete(system: string, user: string): Promise<string> {
    return withModelFallback(this.models, (model) => this.call(model, system, user));
  }

  private async call(model: string, system: string, user: string): Promise<string> {
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
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: {
              temperature: 0.9,
              topP: 0.95,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
            },
          }),
        },
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (isModelRetired(res.status, detail)) {
          throw new ModelRetiredError(`LLM ${res.status}: ${detail.slice(0, 300)}`);
        }
        throw new Error(this.explicarCuota(res.status, detail));
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) throw new Error('LLM devolvio una respuesta vacia.');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Traduce el 429 de Google a un mensaje util.
   *
   * La respuesta cruda dice "You exceeded your current quota" sin decir cuanto
   * queda ni cuando se reinicia. Con un limite diario de 20 peticiones, saber
   * que faltan 14 horas cambia la decision: uno deja de reintentar y sigue
   * trabajando en otra cosa.
   */
  private explicarCuota(status: number, body: string): string {
    if (status !== 429) return `LLM ${status}: ${body.slice(0, 300)}`;

    const limite = body.match(/limit:\s*(\d+)/)?.[1];
    const espera = body.match(/retry in ([\dhms.]+)/)?.[1];

    const partes = ['La cuota diaria de Gemini se agoto.'];
    if (limite) partes.push(`El free tier permite ${limite} peticiones al dia.`);
    if (espera) partes.push(`Se reinicia en ${espera}.`);

    partes.push(
      '',
      'Como queda Frutia con ese limite:',
      '  · El guion gasta 1 de esas peticiones.',
      '  · Las imagenes van por Pollinations, sin limite.',
      '  · La voz corre en tu computador con Piper, sin limite.',
      '',
      `Es decir: puedes producir hasta ${limite ?? '20'} frutinovelas al dia.`,
      'Para mas, hay que activar facturacion en Google Cloud.',
    );

    return partes.join('\n');
  }
}