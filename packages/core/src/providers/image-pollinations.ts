/** Respaldo de imagenes con Pollinations API. */

/** Endpoint con clave: rapido, pero gasta saldo Pollen. */
const BASE = 'https://gen.pollinations.ai/image';

/**
 * Endpoint anonimo: sin clave, sin registro y sin cuota de Pollen.
 *
 * Medido el 12 de octubre de 2026 con cuatro peticiones separadas por 20
 * segundos: respondieron 200 dos veces (4,0 s y 3,6 s) y 402 las otras dos. Es
 * decir, acierta aproximadamente la mitad y hay que insistir.
 *
 * Por eso el modo anonimo solo se usa cuando no hay clave, o cuando la hay
 * pero esta sin saldo. Nunca se abandona una clave que funciona.
 */
const BASE_ANONIMA = 'https://image.pollinations.ai/prompt';

/** Separacion entre peticiones en modo anonimo, en segundos. */
const INTERVALO_ANONIMO_SEG = 20;

/** Intentos en modo anonimo. Acierta 1 de cada 2, asi que 8 deja un fallo de ~0,4 %. */
const INTENTOS_ANONIMOS = 8;

/** Intentos con clave. Sin saldo un 402 no mejora reintentando. */
const INTENTOS_CON_CLAVE = 2;

export interface PollinationsOptions {
  model?: string;
  timeoutMs?: number;
  noLogo?: boolean;
  /** Clave secreta de Pollinations para el backend. */
  token?: string;
  /** Segundos minimos entre peticiones. Por defecto 1. */
  minIntervalSec?: number;
  /**
   * Permite el endpoint anonimo cuando no hay clave, o cuando la que hay esta
   * sin saldo. Por defecto `true`: es la unica via gratuita que no obliga a
   * registrarse, y con el modo $0 es preferible tardar a no tener imagenes.
   */
  allowAnonymous?: boolean;
}

/** Reserva un hueco global entre llamadas para evitar rafagas. */
export class RateLimiter {
  private nextFreeAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextFreeAt);
    this.nextFreeAt = slot + this.minIntervalMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * El endpoint anonimo falla de tres maneras distintas y las tres se reintentan.
 *
 * Medido el 12 de octubre de 2026 con el mismo endpoint:
 *
 *  · `402` — "demasiado rapido". Es el fallo mas frecuente: de cuatro
 *    peticiones separadas por 20 segundos, dos volvieron 402.
 *  · `404` — "todavia no". Una URL de 1.303 caracteres devolvio 404 y, sin
 *    cambiar un parametro, veinte segundos despues devolvio 200 con 67 KB.
 *    El servicio construye la imagen bajo demanda.
 *  · Conexion cortada — `fetch` lanza `SocketError: other side closed` con
 *    cero bytes leidos. No hay codigo HTTP: llega como error de red puro.
 *
 * Los tres son transitorios. El unico que NO mejora reintentando es el 402 de
 * saldo con clave, que se distingue por el texto del cuerpo.
 */
function debeReintentarAnonimo(status: number): boolean {
  return status === 404 || status === 0 || status === 402 || status === 408 || status === 429 || status >= 500;
}

/** Fallos de red o del servidor que conviene repetir siempre. */
function shouldRetry(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export class PollinationsImageProvider {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly noLogo: boolean;
  private readonly token: string | undefined;
  private readonly allowAnonymous: boolean;
  private limiter: RateLimiter;

  /**
   * La clave se quedo sin saldo y se cayo al acceso anonimo.
   *
   * Es publico para que la interfaz y `/api/check` puedan avisar: desde aqui
   * cada imagen tarda hasta 20 segundos y hay que repetir, contra 1 segundo y
   * un acierto seguro con la clave. Es la diferencia entre 2 y 15 minutos, y el
   * usuario tiene que poder verla.
   */
  private anonimo = false;

  /** Peticiones servidas. Se expone para diagnostics. */
  served = 0;
  /** Ultimo error del proveedor, para explicarlo en la interfaz. */
  lastError: string | undefined;

  constructor(opts: PollinationsOptions = {}) {
    this.model = opts.model ?? 'flux';
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.noLogo = opts.noLogo ?? true;
    this.token = opts.token || process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_TOKEN || undefined;
    this.allowAnonymous = opts.allowAnonymous ?? true;
    this.limiter = new RateLimiter(this.intervalo(opts));
  }

  /**
   * Separacion entre peticiones.
   *
   * El anonimo no aguanta rafagas y se mide en 4 segundos por imagen: con
   * menos de 20 entre llamadas, la tasa de acierto cae de la mitad a casi
   * cero. Con clave, en cambio, una peticion por segundo basta.
   */
  private intervalo(opts: PollinationsOptions): number {
    return (opts.minIntervalSec ?? (this.token && !this.anonimo ? 1 : INTERVALO_ANONIMO_SEG)) * 1000;
  }

  /** Si se esta usando una clave que responde, o el acceso anonimo. */
  get hasToken(): boolean {
    return Boolean(this.token) && !this.anonimo;
  }

  /**
   * `true` cuando la peticion va por el endpoint anonimo.
   *
   * No es lo mismo que `modoAnonimo`, que solo significa "le caimos desde una
   * clave sin saldo". Sin clave se nace anonimo, y en ese caso `anonimo`
   * sigue en `false` porque no hubo ninguna caida. Confundir ambos hacia que
   * un 402 de "demasiado rapido" se abortionara como si fuera de saldo.
   */
  private get vaAnonimo(): boolean {
    return !this.token || this.anonimo;
  }

  /** `true` cuando se cayo al endpoint anonimo por falta de saldo. */
  get modoAnonimo(): boolean {
    return this.anonimo;
  }

  async generate(input: {
    prompt: string;
    seed?: number;
    width?: number;
    height?: number;
  }): Promise<{ base64: string; mimeType: string }> {
    const sinClave = !this.token;
    if (sinClave && !this.allowAnonymous) {
      throw new Error(
        'Pollinations requiere una clave secreta en POLLINATIONS_API_KEY. ' +
        'Créala en https://enter.pollinations.ai/keys; las imágenes usan saldo Pollen.',
      );
    }

    const intentos = this.vaAnonimo ? INTENTOS_ANONIMOS : INTENTOS_CON_CLAVE;

    for (let attempt = 1; attempt <= intentos; attempt++) {
      await this.limiter.acquire();
      try {
        return await this.once(input);
      } catch (error) {
        const status = error instanceof StatusError ? error.status : 0;
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;

        // Traza de cada intento. El endpoint anonimo falla de varias maneras a
        // la vez y sin esto no hay forma de saber cual de ellas esta pasando:
        // `FRUTIA_DEBUG_IMAGES=1` en el .env enciende esta linea.
        if (process.env.FRUTIA_DEBUG_IMAGES === '1') {
          console.error(
            `[img] intento ${attempt}/${intentos} `
            + `via=${this.vaAnonimo ? 'anonima' : 'con clave'} `
            + `estado=${status || 'sin respuesta (red)'} `
            + `motivo=${message.replace(/\s+/g, ' ').slice(0, 90)}`,
          );
        }

        // Una clave sin saldo no mejora reintentando, pero el endpoint
        // anonimo si funciona. Caer a el es la diferencia entre seguir
        // haciendo imagenes gratis y quedarse sin ninguna.
        if (!this.anonimo && this.token && this.esSinSaldo(message) && this.allowAnonymous) {
          this.anonimo = true;
          this.limiter = new RateLimiter(this.intervalo({}));
          attempt--; // el cambio de modo no consume un intento
          continue;
        }

        // En anonimo el 402 NO es saldo: es "demasiado rapido". Reintentar es
        // justo lo correcto, y por eso aqui no se aborta.
        if (!this.vaAnonimo && status === 402) {
          throw new Error(
            `Pollinations respondió 402: saldo Pollen o permisos insuficientes (${message}). ` +
            'Revisa https://enter.pollinations.ai; Frutia no repetirá esta llamada.',
          );
        }

        if (!shouldRetry(status) && !(this.vaAnonimo && debeReintentarAnonimo(status))) throw error;
        if (attempt === intentos) {
          throw new Error(`Pollinations falló tras ${attempt} intentos (último: ${message}). ${this.consejo()}`);
        }
        await sleep(1_000 * attempt);
      }
    }

    throw new Error(`Pollinations agotó los reintentos. ${this.consejo()}`);
  }

  /**
   * ¿El 402 es "no quedan fondos" y no "vas demasiado rapido"?
   *
   * Las dos cosas llegan con el mismo codigo y confundirlas es lo que hacia
   * que la app pidiera tres veces una peticion que jamas iba a salir.
   */
  private esSinSaldo(message: string): boolean {
    return /insufficient balance|pollen|insufficient funds|top.?up/i.test(message);
  }

  private consejo(): string {
    if (this.anonimo) {
      return 'Sigue en modo anónimo, que acierta la mitad: reintenta o espera unos segundos.';
    }
    return 'Revisa la clave y el saldo de Pollen en https://enter.pollinations.ai.';
  }

  private async once(input: {
    prompt: string;
    seed?: number;
    width?: number;
    height?: number;
  }): Promise<{ base64: string; mimeType: string }> {
    const conClave = Boolean(this.token) && !this.anonimo;
    const params = new URLSearchParams({
      width: String(input.width ?? 1024),
      height: String(input.height ?? 1536),
      model: this.model,
      nologo: String(this.noLogo),
      ...(input.seed !== undefined ? { seed: String(input.seed) } : {}),
    });

    const url = `${conClave ? BASE : BASE_ANONIMA}/${encodeURIComponent(input.prompt)}?${params}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        // El endpoint anonimo rechaza la cabecera de autorizacion vacia.
        ...(conClave ? { headers: { Authorization: `Bearer ${this.token}` } } : {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new StatusError(res.status, detail.slice(0, 200));
      }

      const mimeType = res.headers.get('content-type') ?? 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('Pollinations devolvió una imagen vacía.');
      this.served++;
      return { base64: buf.toString('base64'), mimeType };
    } finally {
      clearTimeout(timer);
    }
  }
}

class StatusError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Pollinations ${status}: ${detail || '(sin detalle)'}`);
    this.name = 'StatusError';
  }
}
