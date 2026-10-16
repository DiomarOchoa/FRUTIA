/**
 * Proveedor de texto (LLM) para generar el guion y la hoja de personaje.
 *
 * Se habla directamente con la API de Gemini por `fetch` en lugar de usar el
 * SDK: el pipeline ya es asincrono y encadenado, y Evitar una dependencia mas
 * mantiene el bundle del worker pequeno. El resto del proyecto lo compila a
 * `dist/` con ESM nativo.
 */

import { isModelRetired, isModelUnavailable, ModelRetiredError, ModelUnavailableError, modelCandidates, withModelFallback } from './models.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface LlmOptions {
  apiKey: string;
  provider?: 'gemini' | 'ollama';
  ollamaUrl?: string;
  ollamaModel?: string;
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
  private readonly provider: 'gemini' | 'ollama';
  private readonly ollamaUrl: string;
  private readonly ollamaModel: string;

  constructor(private readonly opts: LlmOptions) {
    this.provider = opts.provider ?? 'gemini';
    this.ollamaUrl = (opts.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.ollamaModel = opts.ollamaModel ?? process.env.FRUTIA_OLLAMA_MODEL ?? 'qwen2.5:3b';
    if (this.provider === 'gemini' && !opts.apiKey) throw new Error('LLM: falta GEMINI_API_KEY.');
    this.models = opts.models?.length
      ? opts.models
      : modelCandidates('FRUTIA_LLM_MODEL', [
          'gemini-3.8-flash',
          'gemini-3.7-flash',
          'gemini-3.5-flash',
        ]);
    this.timeoutMs = opts.timeoutMs ?? (this.provider === 'ollama'
      ? Number(process.env.FRUTIA_OLLAMA_TIMEOUT_MS ?? 900_000)
      : DEFAULT_TIMEOUT_MS);
  }

  /**
   * Genera texto plano siguiendo un par de instrucciones.
   * Devuelve el contenido crudo, sin interpretar: el parseo vive en prompts.ts.
   */
  async complete(system: string, user: string): Promise<string> {
    if (this.provider === 'ollama') return this.callOllama(system, user);

    // A diferencia de imagenes, aqui si conviene probar el siguiente modelo
    // cuando el actual esta saturado o sin cuota: la cuota diaria del free
    // tier se lleva por modelo y la saturacion tampoco es compartida.
    return withModelFallback(
      this.models,
      (model) => this.call(model, system, user),
      (error) => error instanceof ModelUnavailableError,
    );
  }

  /**
   * Habla con Ollama en modo streaming.
   *
   * Antes la respuesta llegaba de una sola vez (`stream: false`). Con un modelo
   * grande en CPU el guion tarda varios minutos y fetch (undici) corta la
   * conexion a los 5 minutos sin recibir cabeceras; ese fallo es un TypeError y
   * se mostraba como "no se pudo conectar", aunque Ollama estuviera vivo.
   * Con streaming las cabeceras llegan al instante y el limite de tiempo pasa a
   * ser de INACTIVIDAD: solo salta si el modelo deja de producir texto.
   */
  private async callOllama(system: string, user: string): Promise<string> {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    };
    try {
      const res = await fetch(this.ollamaUrl + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model: this.ollamaModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], format: 'json', stream: true, options: { temperature: 0.8, num_ctx: 8192, num_predict: 2048 } }),
      });
      if (!res.ok) throw new Error('Ollama ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 300));
      if (!res.body) throw new Error('Ollama no devolvio datos.');

      let answer = '';
      const consume = (line: string) => {
        if (!line.trim()) return;
        const part = JSON.parse(line) as { message?: { content?: string }; error?: string };
        if (part.error) throw new Error('Ollama: ' + part.error);
        answer += part.message?.content ?? '';
      };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) consume(line);
      }
      consume(buffer + decoder.decode());

      const text = answer.trim();
      if (!text) throw new Error('Ollama devolvio una respuesta vacia.');
      return text;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Ollama dejo de responder. Comprueba que el modelo local este cargado.');
      if (error instanceof TypeError) {
        const code = (error.cause as { code?: string } | undefined)?.code;
        if (code === 'ECONNREFUSED') throw new Error('No se pudo conectar con Ollama en ' + this.ollamaUrl + '. Inicialo y descarga el modelo configurado.');
        throw new Error('Se corto la conexion con Ollama (' + (code ?? error.message) + '). Ollama sigue abierto?');
      }
      throw error;
    } finally { clearTimeout(timer); }
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
        // Saturado (503) o sin cuota (429) no son motivo para rendirse: el
        // siguiente modelo de la lista tiene su propia capacidad y su propia
        // cuota, y suele responder. Antes esto se propagaba y la app se
        // quedaba sin guion aunque los dos siguientes estuvieran sanos.
        if (isModelUnavailable(res.status, detail)) {
          throw new ModelUnavailableError(`LLM ${res.status}: ${detail.slice(0, 300)}`);
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