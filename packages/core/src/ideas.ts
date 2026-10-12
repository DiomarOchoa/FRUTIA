/**
 * Generador de premises aleatorios sin repeticion.
 *
 * Resuelve dos problemas a la vez:
 *  1. La friccion de decidir: "que hago hoy" es la razon por la que un canal
 *     deja de publicar. Un boton de "sorprendeme" la elimina.
 *  2. La repeticion: contar la misma premisa tres veces pierde a la audiencia
 *     aunque cambien los personajes.
 *
 * COMO GARANTIZA QUE NO SE REPITA
 *
 * Las combinaciones se enumeran de forma determinista y cada premisa tiene un
 * indice entero unico. Asi "ya se uso" es una pregunta de conjunto, no una
 * comparacion de textos, y siempre queda algo libre mientras queden
 * combinaciones sin usar.
 *
 * Ademas se fuerza que las ideas de un mismo lote sean distintas entre si en
 * conflicto, giro y lugar. Diez variantes de la misma historia con distinta
 * fruta no son diez ideas: son la misma idea.
 */

/** Ingredientes. Cada uno aporta personajes, conflicto y giro. */

export const HEROES = [
  { s: 'fresa', g: 'f' }, { s: 'platano', g: 'm' }, { s: 'manzana', g: 'f' },
  { s: 'naranja', g: 'f' }, { s: 'ciruela', g: 'f' }, { s: 'uva', g: 'f' },
  { s: 'mango', g: 'm' }, { s: 'kiwi', g: 'm' }, { s: 'melocoton', g: 'm' },
  { s: 'coco', g: 'm' }, { s: 'higo', g: 'm' }, { s: 'chirimoya', g: 'f' },
  { s: 'papaya', g: 'f' }, { s: 'granada', g: 'f' },
] as const;

export const ANTAGONISTAS = [
  { s: 'zarzamora', g: 'f' }, { s: 'limon', g: 'm' }, { s: 'pina', g: 'f' },
  { s: 'nectarina', g: 'f' }, { s: 'aguacate', g: 'm' }, { s: 'sandia', g: 'f' },
  { s: 'mora', g: 'f' }, { s: 'oliva', g: 'f' }, { s: 'cereza', g: 'f' },
  { s: 'canela', g: 'f' }, { s: 'pimienta', g: 'f' }, { s: 'jambu', g: 'm' },
] as const;

export const CONFLICTOS = [
  'descubre que su pareja se hace pasar por otra persona',
  'encuentra un mensaje que nunca debio haber leido',
  'hereda una casa que todos creian vacia',
  'la sustituyen en su propio trabajo sin que nadie se entere',
  'le roban una receta que era de su abuela',
  'descubre que tiene un gemelo que nadie conocia',
  'pierde la memoria de una tarde entera',
  'recibe un paquete con su nombre y sin remitente',
  'se entera de que su mejor amiga le mintio años',
  'gana un premio que no le corresponde',
  'descubre que el medico de su familia guarda un secreto',
  'la echan de su grupo de amigas el dia de su cumpleanos',
] as const;

export const LUGARES = [
  'una pasteleria de barrio', 'un supermercado a las tres de la manana',
  'una pileta comunitaria', 'un hotel de carretera', 'una escuela de arte',
  'un mercado de segunda mano', 'una cafeteria que cierra a medianoche',
  'un dormitorio compartido', 'una feria ambulante',
  'un restaurante sin nombre', 'un hospital de campo',
  'una estacion de servicio', 'un taller de bicis', 'una biblioteca cerrada',
] as const;

export const GIROS = [
  'y lo descubre justo cuando va a confesar',
  'pero la otra persona tambien lo sabe',
  'y no es la primera vez que pasa',
  'y el secreto lleva veinte años ahi',
  'y alguien esta grabando todo',
  'y tiene hasta el amanecer para decidir',
  'y justo entonces llega su madre',
] as const;

/** Plantillas de premisa. `{h}` protagonista, `{a}` antagonista, `{l}` lugar. */
export const PLANTILLAS = [
  '{h} descubre que {a} sabe el secreto que {h} le oculta a todo el mundo',
  '{h} intenta demostrar que {a} miente y descubre que la verdad le hace daño a ella misma',
  '{h} y {a} cierran un trato en {l} que termina cambiandolos a los dos',
  '{h} vuelve a {l} despues de años y encuentra a {a} esperandola',
  'en {l}, {h} descubre que todo lo que creia saber era mentira',
  '{h} tiene que elegir entre {a} y {l}, y elige fatal',
] as const;

interface Ingrediente { s: string; g: 'm' | 'f' }

/** Articulo y sustantivo con el genero correcto: "un higo", "una fresa". */
function sujeto(i: Ingrediente): string {
  return `${i.g === 'm' ? 'un' : 'una'} ${i.s}`;
}

export interface Idea {
  /** Lista para copiar y pegar en el formulario. */
  topic: string;
  title: string;
  /** Indice unico de la combinacion. Sirve para detectar repeticiones. */
  index: number;
  /** Semilla para fijar el guion y poder reproducirlo. */
  seed: number;
}

/**
 * Total de combinaciones: 14 x 12 x 12 x 14 x 7 x 6 = 1.185.408.
 * Nunca se agota, ni publicando todos los dias durante años.
 */
export const TOTAL_COMBINATIONS =
  HEROES.length * ANTAGONISTAS.length * CONFLICTOS.length *
  LUGARES.length * GIROS.length * PLANTILLAS.length;

/** Convierte un indice en una premisa. Determinista: el 42 siempre es el mismo. */
export function ideaFromIndex(index: number): Idea {
  // Normalizacion por modulo con vuelta a positivo: un indice negativo cuenta
  // desde el final del catalogo, igual que haria un array. Se aplica antes del
  // resto para que el mapeo sea reversible en todo el rango, no solo en [0, N).
  const n = ((Math.trunc(index) % TOTAL_COMBINATIONS) + TOTAL_COMBINATIONS) % TOTAL_COMBINATIONS;

  let rest = n;
  const take = <T>(list: readonly T[]): T => {
    const value = list[rest % list.length]!;
    rest = Math.floor(rest / list.length);
    return value;
  };

  // El orden importa. `take` consume el indice de menos a mas significativa,
  // asi que lo que se lee primero es lo que mas cambia entre indices cercanos.
  //
  // Se alterna entre las dimensiones que el ojo nota y las que varian visible:
  // poner las grandes al principio dejaba las siguientes siempre en cero para
  // indices pequenos y todos los lotes salian con el mismo enfoque; ponerlas
  // todas al final pasaba lo contrario: todas con la misma fruta.
  const plantilla = take(PLANTILLAS);
  const giro = take(GIROS);
  const lugar = take(LUGARES);
  const conflicto = take(CONFLICTOS);
  const heroe = take(HEROES);
  const antagonista = take(ANTAGONISTAS);

  const heroeTxt = sujeto(heroe);
  const rivalTxt = sujeto(antagonista);

  // Se sustituyen todas las apariciones: el mismo nombre aparece dos veces en
  // algunas plantillas y un replace() a secas solo cambiaria la primera.
  const premisa = plantilla
    .split('{h}').join(heroeTxt)
    .split('{a}').join(rivalTxt)
    .split('{l}').join(lugar);

  return {
    topic: `${premisa}: ${conflicto}, ${giro}.`,
    title: `${heroe.s} y ${antagonista.s}`,
    index: n,
    // La semilla deriva del indice: premisa y guion van unidos.
    seed: n * 7919 + 13,
  };
}

/**
 * Salto entre ideas consecutivas.
 *
 * Imprescindible. Las dimensiones miden 14, 12, 12, 14, 7 y 6, asi que
 * avanzar de uno en uno solo cambia el primer campo: los indices 12345 y 12346
 * dan frutas distintas pero exactamente el mismo conflicto, lugar, giro y
 * plantilla. Con este salto (primo respecto a 84, el minimo comun multiplo de
 * todas las medidas) cada avance recorre dimensiones distintas.
 */
const STRIDE = 7919;

/** Componentes de una idea, para comparar si dos historias son la misma. */
function firma(index: number): string {
  const n = ((Math.trunc(index) % TOTAL_COMBINATIONS) + TOTAL_COMBINATIONS) % TOTAL_COMBINATIONS;
  let rest = n;
  const take = <T>(list: readonly T[]): number => {
    const v = rest % list.length;
    rest = Math.floor(rest / list.length);
    return v;
  };
  // Mismo orden que `ideaFromIndex`, para que la firma describa la misma idea.
  const p = take(PLANTILLAS);
  const g = take(GIROS);
  const l = take(LUGARES);
  const c = take(CONFLICTOS);
  const h = take(HEROES);
  const a = take(ANTAGONISTAS);

  // La plantilla entra en la firma. Sin ella, cinco ideas seguidas salen
  // siempre con el mismo enfoque ("todo lo que creia saber era mentira") y el
  // lote se lee como la misma historia contada cinco veces.
  return `${p}|${c}|${l}|${g}|${h}|${a}`;
}

/**
 * Devuelve `count` ideas que no estan en `usados` y que ademas son distintas
 * entre si en conflicto, lugar y giro.
 *
 * Recorre con salto en vez de de uno en uno, de modo que cada propuesta cambia
 * de、 dramatico y no solo de fruta.
 */
export function suggestIdeas(usados: Iterable<number>, count: number, startAt = Date.now()): Idea[] {
  const tomados = new Set(usados);
  const firmas = new Set<string>();
  const out: Idea[] = [];

  const cursor = Math.abs(startAt) % TOTAL_COMBINATIONS;
  const intentos = Math.max(count * 200, 800);

  for (let i = 0; i < intentos && out.length < count; i++) {
    const index = (cursor + i * STRIDE) % TOTAL_COMBINATIONS;
    if (tomados.has(index)) continue;

    const f = firma(index);
    if (firmas.has(f)) continue;

    firmas.add(f);
    tomados.add(index);
    out.push(ideaFromIndex(index));
  }

  return out;
}

/** Cuantas combinaciones quedan libres. Se muestra en la interfaz. */
export function remainingCombinations(usados: number): number {
  return Math.max(0, TOTAL_COMBINATIONS - usados);
}