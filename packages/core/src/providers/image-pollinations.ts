/**
 * Proveedor de imagenes alternativo: Pollinations.ai.
 *
 * Existe por un motivo concreto: el free tier de Google puede devolver
 * `429` con cuota cero en imagenes segun el estado de la cuenta. Ese modelo
 * ha sido el cuello de botella del modo $0, y este proveedor lo resuelve
 * sin clave, sin registro y sin tarjeta.
 *
 * LIMITACION CRITICA (medida, no supuesta): el acceso anonimo es ERRATICO.
 * En pruebas con separaciones de 0, 3, 6, 9, 12, 15, 20 y 25 segundos, solo
 * respondieron 200 la primera y la de 20 segundos; el resto devolvio 402. No
 * existe un intervalo que funcione siempre, asi que no se puede "sintonizar"
 * un ritmo fiable: hay que reintentar.
 *
 * Por eso aqui hay dos mecanismos:
 *  1. Un limitador global que separa las peticiones y evita saturarlo.
 *  2. Reintentos persistentes: en la practica uno de cada tres intentos
 *     funciona, asi que con 8 intentos la probabilidad de fallo de una imagen
 *     es de ~5 por ciento.
 *
 * Consecuencia practica: una frutinovela de 13 imagenes puede tardar 10-15
 * minutos y no es determinista. Funciona sin gastar un peso, pero es lento y
 * poco fiable. La alternativa estable es activar la facturacion de Google.
 *
 * Limitacion honesta: no admite imagenes de referencia, asi que la
 * consistencia del personaje se apoya solo en la descripcion textual.
 */

const BASE = 'https://gen.pollinations.ai/image';
/** Endpoint antiguo, sin autenticacion. Se usa como respaldo. */
const BASE_LEGACY = 'https://image.pollinations.ai/prompt';

export interface PollinationsOptions {
  model?: string;
  timeoutMs?: number;
  noLogo?: boolean;
  /** Token de una cuenta gratuita de Pollinations: sube el limite y lo hace fiable. */
  token?: string;
  /** Segundos minimos entre peticiones. Por defecto 20. */
  minIntervalSec?: number;
}

/**
 * Limitador global de peticiones.
 *
 * Es global a proposito: el pipeline lanza imagenes desde varios caminos
 * (fichas de personaje, planos, regeneraciones) y todos comparten la misma
 * cuota de la IP. Un limitador por instancia dejaria pasar el doble.
 */
export class RateLimiter {
  private nextFreeAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  /**
   * Espera a que haya hueco y reserva el siguiente.
   *
   * UNA sola pasada, y esto no es negociable. La version anterior rodeaba esto
   * de `for (;;)`, y el bucle no terminaba nunca: al reservar el hueco se
   * empujaba `nextFreeAt` hacia adelante, asi que al despertar la espera
   * siguiente era exactamente la misma y `wait` jamas llegaba a cero. La
   * segunda imagen de cualquier historia se quedaba esperando para siempre.
   *
   * Medido: diecisiete minutos de proceso vivo sin producir una sola imagen.
   * La reserva se hace en una pasada y dormir de mas no pasa nada, porque el
   * hueco ya quedo apartado para esta peticion y las siguientes se encolan
   * detras suyo.
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextFreeAt);
    this.nextFreeAt = slot + this.minIntervalMs;

    const wait = slot - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 402 y 429 significan "demasiado rapido"; 5xx es transitorio. */
function shouldRetry(status: number): boolean {
  return status === 402 || status === 429 || status === 408 || status >= 500;
}

export class PollinationsImageProvider {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly noLogo: boolean;
  private readonly token: string | undefined;
  private limiter: RateLimiter;

  /**
   * Se activa cuando la clave secreta se queda sin saldo de Pollen.
   *
   * Es un caso real y frecuente: la clave gratuita arranca con algo de saldo,
   * lo gasta y empieza a devolver `402 Insufficient balance`. El acceso
   * anonimo de toda la vida sigue respondiendo, solo que mas despacio y con
   * mas errores. Antes de este campo, ese 402 era el final del camino y el
   * usuario se quedaba sin imagenes; ahora se degrada sola al anonimo.
   */
  private anonMode = false;

  /** Peticiones servidas. Se expone para diagnostics. */
  served = 0;

  constructor(opts: PollinationsOptions = {}) {
    this.model = opts.model ?? 'flux';
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.noLogo = opts.noLogo ?? true;
    // Se aceptan los tres nombres por comodidad: la documentacion oficial usa
    // POLLINATIONS_API_KEY, y TOKEN es lo que se leia antes.
    this.token =
      opts.token
      || process.env.POLLINATIONS_API_KEY
      || process.env.POLLINATIONS_TOKEN
      || undefined;
    this.limiter = new RateLimiter(this.intervalo(opts));
  }

  /**
   * Segundos minimos entre peticiones.
   *
   * Sin clave el servicio es erratico y hay que separarlo mas; con clave
   * las claves secretas no tienen limite y se puede ir rapido.
   *
   * El valor por defecto con token es 1s, no 3s: medido, una imagen tarda
   * unos 7,6s en generarse, asi que 3s de espera solo anade latencia sin
   * evitar ningun error. Y al bajar a 1s, un reintento ya no cuesta 20s.
   */
  private intervalo(opts: PollinationsOptions): number {
    return (opts.minIntervalSec ?? (this.token && !this.anonMode ? 1 : 20)) * 1000;
  }

  /** Con clave utilizable, el servicio no impone el limite erratico del acceso anonimo. */
  get hasToken(): boolean {
    return Boolean(this.token) && !this.anonMode;
  }

  /**
   * Si la clave se quedo sin saldo y el proveedor cayo al acceso anonimo.
   *
   * Es publico para que `/api/check` pueda avisar: sin este dato el usuario ve
   * "imagenes OK" y no sabe que esta pagando cada imagen con esperas de 20
   * segundos en vez de 1, que es la diferencia entre 2 y 15 minutos.
   */
  get modoAnonimo(): boolean {
    return this.anonMode;
  }

  /**
   * ¿El fallo es "no quedan fondos" y no "vas demasiado rapido"?
   *
   * Las dos cosas llegan como 402 y confundirlas es lo que rompia el modo $0:
   * el codigo reintentaba varias veces una peticion que jamas iba a
   * funcionar, gastaba un minuto de espera y al final fallaba igual.
   */
  private esSinSaldo(message: string): boolean {
    return /insufficient balance|pollen|insufficient funds|top.?up/i.test(message);
  }

  async generate(input: {
    prompt: string;
    seed?: number;
    width?: number;
    height?: number;
  }): Promise<{ base64: string; mimeType: string }> {
    for (let attempt = 1; attempt <= this.intentosMax(); attempt++) {
      await this.limiter.acquire();

      try {
        return await this.once(input);
      } catch (error) {
        const status = error instanceof StatusError ? error.status : 0;
        const message = error instanceof Error ? error.message : String(error);

        // La clave se quedo sin saldo. Antes de rendirse se cae al acceso
        // anonimo, que sigue funcionando gratis: es la diferencia entre
        // seguir produciendo imagenes y quedarse sin nada. El intento no
        // cuenta como fallido porque no fue un fallo de esta peticion.
        if (!this.anonMode && this.token && this.esSinSaldo(message)) {
          this.anonMode = true;
          this.lastError = 'La clave de Pollinations se quedo sin saldo; se sigue en modo anonimo.';
          this.limiter = new RateLimiter(this.intervalo({}));
          continue;
        }

        if (!shouldRetry(status)) throw error;

        this.lastError = message;

        // El ultimo intento no se reintenta: hay que fallar y que la interfaz
        // lo muestre, en vez de quedarse esperando en silencio.
        if (attempt === this.intentosMax()) {
          throw new Error(
            `Pollinations fallo tras ${attempt} intentos (ultimo: ${message}). ` + this.consejo(),
          );
        }

        // Sin clave el ritmo ya lo impone el limitador; con clave se espera mas.
        const esperaLarga = this.hasToken ? 30_000 : 0;
        if (esperaLarga > 0) await sleep(esperaLarga * attempt);
      }
    }

    throw new Error('Pollinations: se agotaron los reintentos. ' + this.consejo());
  }

  /**
   * Cuantos intentos caben.
   *
   * Con clave utilizable no hay limite y un 402 casi siempre es cuota o un
   * fallo puntual: reintentar ocho veces solo multiplica la espera sin
   * corregir nada. Sin clave el servicio es erratico y hay que insistir,
   * porque uno de cada tres intentos acierta.
   */
  private intentosMax(): number {
    return this.hasToken ? 3 : 8;
  }

  private consejo(): string {
    return this.token && !this.anonMode
      ? 'Si la clave es correcta, puede que se haya agotado la cuota de Pollen: revisa https://enter.pollinations.ai'
      : 'Registrate en https://enter.pollinations.ai/keys y define POLLINATIONS_API_KEY, o activa la facturacion de Google.';
  }

  /** Ultimo error del proveedor, para explicarlo en la interfaz. */
  lastError: string | undefined;

  private async once(input: {
    prompt: string;
    seed?: number;
    width?: number;
    height?: number;
  }): Promise<{ base64: string; mimeType: string }> {
    // Con clave utilizable se usa el endpoint actual; en modo anonimo, el
    // clasico, que es el unico que funciona sin saldo ni registro.
    const conToken = Boolean(this.token) && !this.anonMode;
    const base = conToken ? BASE : BASE_LEGACY;
    const params = new URLSearchParams({
      width: String(input.width ?? 1024),
      height: String(input.height ?? 1536),
      model: this.model,
      nologo: String(this.noLogo),
      ...(input.seed !== undefined ? { seed: String(input.seed) } : {}),
      // El endpoint clasico solo acepta la clave por parametro, y solo tiene
      // sentido si de verdad la hay que usar.
      ...(!conToken && process.env.POLLINATIONS_API_KEY
        ? { key: process.env.POLLINATIONS_API_KEY }
        : {}),
    });

    const url = `${base}/${encodeURIComponent(input.prompt)}?${params}`;
    const headers: Record<string, string> = {};
    if (conToken) headers.Authorization = `Bearer ${this.token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, { headers, signal: controller.signal });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new StatusError(res.status, detail.slice(0, 200));
      }

      const mimeType = res.headers.get('content-type') ?? 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('Pollinations devolvio una imagen vacia.');

      this.served++;
      return { base64: buf.toString('base64'), mimeType };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Error con codigo HTTP, para decidir si conviene reintentar. */
class StatusError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Pollinations ${status}: ${detail || '(sin detalle)'}`);
    this.name = 'StatusError';
  }
}