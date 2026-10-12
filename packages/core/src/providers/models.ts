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
 * Ejecuta `attempt` contra cada modelo candidato hasta que uno funcione.
 *
 * Solo avanza al siguiente si el fallo fue una retirada; cualquier otro error
 * se propaga de inmediato, porque reintentar con otro modelo seria gastar
 * cuota a cambio de nada.
 */
export async function withModelFallback<T>(
  models: string[],
  attempt: (model: string) => Promise<T>,
): Promise<T> {
  const failures: string[] = [];

  for (const model of models) {
    try {
      return await attempt(model);
    } catch (error) {
      failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      if (!(error instanceof ModelRetiredError)) throw error;
    }
  }

  throw new Error(
    `Ningun modelo disponible. Se probaron:\n${failures.join('\n')}\n\n` +
      'Sobrescribe el modelo con la variable de entorno correspondiente (ver .env.example).',
  );
}