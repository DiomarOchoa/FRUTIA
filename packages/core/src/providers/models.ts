/**
 * Seleccion de modelo con degradacion automatica.
 *
 * Google retira modelos muy deprisa: `gemini-2.5-flash` dejo de estar
 * disponible para cuentas nuevas a mitad de 2026, y las familias de imagen
 * cambian de sufijo cada pocas semanas. Un nombre fijo en el codigo convierte
 * cada retirada en una caida del producto.
 *
 * Aqui se concentran las dos defenses:
 *  1. El modelo se puede sobrescribir por variable de entorno.
 *  2. Si el principal devuelve 404 por retirada, se prueba el siguiente de la
 *     lista sin que el usuario tenga que tocar nada.
 */

/** Orden de preferencia. El override del entorno va siempre primero. */
export function modelCandidates(envKey: string, defaults: string[]): string[] {
  const override = (process.env[envKey] ?? '').trim();
  return [...new Set([...(override ? [override] : []), ...defaults])];
}

/**
 * Indica si el fallo es "este modelo ya no existe" y no un problema de la
 * peticion, la cuota o la red.
 *
 * Distinguirlo importa: ante un 429 o un 400 de contenido, cambiar de modelo
 * no arregla nada y solo gasta llamadas de la cuota gratuita.
 */
export function isModelRetired(status: number, body: string): boolean {
  if (status !== 404 && status !== 400) return false;
  return /no longer available|not found|is not supported|unsupported model|deprecat/i.test(body);
}

/** Marca un modelo como retirado para poder recorrer la lista de candidatos. */
export class ModelRetiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRetiredError';
  }
}

/**
 * El modelo existe pero no puede atender la peticion ahora mismo.
 *
 * Dos motivos reales y distintos se agrupan aqui:
 *
 *  1. `503 high demand`. Google satura los modelos gratuitos por oleadas. En
 *     una prueba del 12 de octubre de 2026, `gemini-3.8-flash` devolvio 503
 *     tres veces seguidas mientras `gemini-3.7-flash` respondia en 6,7 s y
 *     `gemini-3.5-flash` en 0,9 s. Como el 503 no era una retirada, la
 *     cascada se rendia en el primer modelo y la app no podia escribir un solo
 *     guion, con dos modelos siguientes perfectamente sanos.
 *
 *  2. `429 quota`. El limite diario del free tier es POR MODELO ("limit: 20,
 *     model: gemini-3.8-flash"), asi que el siguiente modelo tiene su propia
 *     cuota y suele servir.
 *
 * En los dos casos la respuesta correcta es la misma: probar el siguiente.
 */
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/** Â¿Este error se resuelve probando otro modelo? */
export function isModelUnavailable(status: number, body: string): boolean {
  if (status === 503) return true;
  if (status !== 429) return false;
  return /quota|exceeded|resource_exhausted|rate limit|overloaded/i.test(body);
}

/**
 * Ejecuta `attempt` contra cada modelo candidato hasta que uno funcione.
 *
 * Por defecto solo avanza si el fallo fue una retirada, porque en imagenes un
 * 429 significa "sin cuota de imagenes" y lo correcto es cambiar de proveedor
 * entero, no de modelo. Para texto, `shouldAdvance` se amplia a saturacion y
 * cuota, que es justo donde cambiar de modelo si funciona.
 */
export async function withModelFallback<T>(
  models: string[],
  attempt: (model: string) => Promise<T>,
  shouldAdvance?: (error: Error) => boolean,
): Promise<T> {
  const failures: string[] = [];

  const avanza = (error: Error): boolean =>
    error instanceof ModelRetiredError || (shouldAdvance?.(error) ?? false);

  for (const model of models) {
    try {
      return await attempt(model);
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      failures.push(`${model}: ${e.message}`);
      if (!avanza(e)) throw e;
    }
  }

  throw new Error(
    `Ningun modelo disponible. Se probaron:\n${failures.join('\n')}\n\n` +
      'Sobrescribe el modelo con la variable de entorno correspondiente (ver .env.example).',
  );
}
