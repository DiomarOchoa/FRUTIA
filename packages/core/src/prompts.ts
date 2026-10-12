/**
 * Prompts y plantillas de Frutia.
 *
 * Este archivo es el corazón del producto: define qué es una frutinovela, como
 * se construye su arco dramatico y como se describe un personaje de forma tan
 * precisa que el modelo de imagen lo mantenga consistente entre planos.
 *
 * La consistencia se logra congelando `visualDescription` una vez: la imagen de
 * referencia se reinyecta en cada generacion posterior del personaje.
 */

import type { Archetype, Character, Scene, Story } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Catalogo de arquetipos
// ─────────────────────────────────────────────────────────────────────────────

export interface ArchetypeSpec {
  /** Descripcion visual canonica. Se concatena al prompt de imagen. */
  visual: string;
  /** Arquetipo psicologico que guía la escritura del guion. */
  personality: string;
  /** Etiqueta sugerida para la voz del TTS. */
  voiceTone: string;
}

/**
 * Los arquetipos no son solo de guion: cada uno trae una apariencia fija que el
 * modelo de imagen puede replicar. Esa separacion (personalidad vs. aspecto)
 * es lo que permite cambiar el tono de la historia sin romper el diseño.
 */
export const ARCHETYPES: Record<Archetype, ArchetypeSpec> = {
  hero: {
    visual: 'expresión inocente y esperanzada, pupilas brillantes, postura abierta',
    personality: 'la protagonista: noble, ingenua y con un corazón demasiado grande',
    voiceTone: 'femenina-joven',
  },
  villain: {
    visual: 'cejas marcadas y arqueadas, sonrisa desviada, mirada calculadora',
    personality: 'la traidora: manipuladora, vanidosa y siempre un paso adelante',
    voiceTone: 'femenina-alta',
  },
  naive: {
    visual: 'ojos muy abiertos, sonrisa ausente, expresión desprevenida',
    personality: 'la confiada que no ve venir la catastrophe',
    voiceTone: 'femenina-juvenil',
  },
  rival: {
    visual: 'mirada afilada, labios apretados, postura rígida',
    personality: 'la competencia directa: ambiciosa, visible y calculadora',
    voiceTone: 'femenina-media',
  },
  bestie: {
    visual: 'mirada cálida y atenta, gesto de apoyo',
    personality: 'la confidente: leal, sarcástica y siempre tiene un plan B',
    voiceTone: 'femenina-cálida',
  },
  boss: {
    visual: 'mirada desde arriba, postura imponente, gestos amplios',
    personality: 'la jefa: controla cada gesto de la escena',
    voiceTone: 'femenina-grave',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Estilos visuales
// ─────────────────────────────────────────────────────────────────────────────

export interface StyleSpec {
  id: string;
  label: string;
  /** Fragmento que se concatena al prompt de imagen. */
  prompt: string;
}

/**
 * Estilos visuales.
 *
 * Solo se ofrecen los que funcionan bien con los proveedores reales. Los
 * antiguos ("stop motion de plastilina", "papel recortado") se quitaron porque
 * Flux los interpretaba de forma inconsistente: pedia plastilina y devolvia
 * render 3D, lo que rompia la coherencia entre planos.
 */
export const STYLES: StyleSpec[] = [
  {
    id: 'pixar3d',
    label: 'Pixar 3D (el viral)',
    prompt:
      'render 3D estilo Pixar de pelicula animada, materiales PBR mate con subsurface scattering, ' +
      'iluminacion cinematica de tres puntos con luz principal calida y relleno frio, ' +
      'profundidad de campo corta y bokeh suave, caracter de pelicula de animacion, ' +
      'expresiones faciales muy expresivas, detalle en la piel',
  },
  {
    id: 'pixar3d-real',
    label: 'Pixar 3D con decorado',
    prompt:
      'render 3D estilo Pixar de pelicula animada, decorado interior detailed con profondeur, ' +
      'muebles y objetos en segundo plano desenfocados, luz natural de ventana con rayos visibles, ' +
      'personaje de cuerpo entero centrado con la cabeza y los brazos dentro del encuadre, ' +
      'tejidos y objetos con textura real, profundidad de campo cinematografica',
  },
  {
    id: 'render3d',
    label: 'Render 3D limpio',
    prompt:
      'render 3D estilo Pixar satirical, materiales mate, subsurface scattering sutil, ' +
      'iluminacion de tres puntos, profundidad de campo suave',
  },
  {
    id: 'pixelart',
    label: 'Pixel art 16-bit',
    prompt:
      'pixel art 16-bit con paleta limitada, dithering visible, sombreado limitado, ' +
      'sprite centrado, estetica de videojuego retro de 1996',
  },
  {
    id: 'claymation',
    label: 'Arcilla y miniature',
    prompt:
      'miniature set de arcilla cocida a mano, escala de maqueta de 1/12, ' +
      'pov de tabletop con profundidad de campo corta, sensacion tactil',
  },
];

/**
 * El estilo por defecto es el del viral.
 *
 * No es una cuestion estetica: los demas estilos dan personajes de cuerpo
 * partido y fondos planos, y eso hace que dos planos consecutivos se vean como
 * peliculas distintas.
 */
export const DEFAULT_STYLE_ID = 'pixar3d';

export function resolveStyle(styleId: string): StyleSpec {
  // `STYLES` no esta vacio por construccion; el fallback cubre solo el caso
  // defensivo de un id desconocido que venga de un LLM.
  return STYLES.find((s) => s.id === styleId) ?? STYLES[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construccion del guion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Distribución de planos por rol. La suma da `sceneCount` planos.
 * El hook y el cliffhanger se duplican porque son los dos momentos que mas
 * influyen en el retention.
 */
export const SCENE_ROLE_SEQUENCE: Scene['role'][] = [
  'hook',
  'setup',
  'setup',
  'conflict',
  'escalation',
  'escalation',
  'turn',
  'cliffhanger',
];

export const SYSTEM_PROMPT = `Eres un guionista especializado en "frutinovelas": minidramas
verticales para TikTok, Reels y Shorts donde personajes antropomorficos (frutas,
verduras u objetos de cocina) viven melodramas absurdos.

REGLAS DE ESTRUCTURA

1. ARCO. Cada historia sigue esta secuencia exacta de planos:
   hook -> setup -> setup -> conflict -> escalation -> escalation -> turn -> cliffhanger
   El hook (plano 1) no muestra la premisa: lanza una pregunta o una imagen
   perturbadora que obliga a seguir viendo.
   El cliffhanger (plano final) corta a mitad de una escena y anuncia la parte 2.

2. DURACION (CRITICO, NO LO IGNORES).

   El video debe durar MAS DE 60 SEGUNDOS. TikTok solo paga los videos de un
   minuto o mas, asi que un guion de 56 segundos vale cero.

   Este es el calculo, respectalo al pie de la letra:

   - El hook dura 3-4 segundos de voz.
   - Los demas planos necesitan UNas 9-10 palabras de narracion cada uno.
     Con menos de 8 palabras, el plano se queda corto y el total no llega.
   - Total objetivo: entre 70 y 80 segundos. Apunta ahi, no a 60justo.

   Un ejemplo con 8 planos: hook de 12 palabras + 7 planos de 20 palabras
   cada uno = unas 152 palabras en total. Si escribes menos, no llegas.

   COMPRUEBA ANTES DE RESPONDER: cuenta las palabras de la narracion de cada
   plano. Ningun plano central debe tener menos de 9 palabras. Si te quedas
   corto, alarga las frases: es mejor un plano de 15 palabras que dos planos
   de 6.

   Narra poco por plano en cuanto a PAUSAS, no en cuanto a palabras: las
   comas y los puntos hacen que la voz sintetica suene natural.

3. LENGUAJE. Español latinoamericano colloquial. Frases cortas. Nada de
   lenguaje florido ni voz en off literary. El drama se cuenta con hechos
   concretos, no con adjetivos. Evita la voz en off literaria.

4. DIALOGO. Cuando un personaje habla, escribe su nombre así:
   MANGO: [narracion]. El motor de voz separa los turnos por estos nombres.

5. VISUAL. Cada plano describe una sola toma, en una frase, sin plurales.
   Describe solo lo que se ve. No menciones camara, angulo ni plano tecnico:
   el motor de imagen decide la encuadre.

FORMATO DE SALIDA

Responde unicamente con JSON valido, sin markdown ni cercas de codigo:

{
  "title": "titulo corto y contundente",
  "premise": "una sola linea",
  "visualStyleId": "<uno de los estilos disponibles>",
  "characters": [
    {
      "name": "Nombre",
      "species": "fresa",
      "archetype": "hero",
      "visualDescription": "descripcion visual densa y concreta",
      "personality": "una frase"
    }
  ],
  "scenes": [
    {
      "role": "hook",
      "narration": "PERSONAJE: texto hablado. Texto narrado.",
      "shotDescription": "una frase",
      "characterIds": ["c1"]
    }
  ]
}

Los IDs de personaje son "c1", "c2", ... y deben referenciar personajes
declarados. No inventes personajes que no esten en la lista.`;

/**
 * Permite al usuario fijar el numero de planos sin romper el arco.
 *
 * El hook y el cliffhanger son intocables: son los dos planos que mas pesan en
 * el retention. Solo los planos centrales se recortan o se repiten.
 */
function roleSequenceFor(sceneCount: number): Scene['role'][] {
  const base = [...SCENE_ROLE_SEQUENCE];
  const hook = base[0]!;
  const closer = base[base.length - 1]!;
  const wanted = Math.max(2, sceneCount);

  if (wanted <= base.length) {
    const middle = base.slice(1, -1).slice(0, wanted - 2);
    return [hook, ...middle, closer];
  }

  const middle = base.slice(1, -1);
  let i = 0;
  while (middle.length < wanted - 2) {
    middle.push(middle[i % middle.length]!);
    i++;
  }
  return [hook, ...middle.slice(0, wanted - 2), closer];
}

export interface BuildScriptPromptOptions {
  topic: string;
  sceneCount?: number;
  styleId?: string;
  tone?: string;
  locale?: string;
  seed?: number;
}

export function buildScriptUserPrompt(opts: BuildScriptPromptOptions): string {
  const sceneCount = opts.sceneCount ?? SCENE_ROLE_SEQUENCE.length;
  const style = resolveStyle(opts.styleId ?? DEFAULT_STYLE_ID);
  const roles = roleSequenceFor(sceneCount);

  return `TEMA: ${opts.topic}

TONO: ${opts.tone ?? 'melodramático con humor negro'}

ESTILO VISUAL: ${style.label} (visualStyleId: "${style.id}")

NUMERO DE PLANOS: ${sceneCount}

SECUENCIA DE ROLES, en este orden exacto:
${roles.map((r, i) => `${i + 1}. ${r}`).join('\n')}

MERCADO: ${opts.locale ?? 'es-419'}${opts.seed !== undefined ? `\nSEMILLA CREATIVA: ${opts.seed}` : ''}

Personajes permitidos (usa de 3 a 5):
${Object.entries(ARCHETYPES)
  .map(([k, v]) => `- ${k}: ${v.personality}`)
  .join('\n')}

COMO DESCRIBIR A CADA PERSONAJE (campo "visualDescription")

Esta es la parte mas importante del guion. El modelo de imagen no recuerda al
personaje entre planos: solo ve esta frase. Para que la fruta se parezca a si
misma en todas las tomas, la descripcion debe:

1. Empezar por la FRUTA y su color exacto: "fresa roja con pepitas amarillas".
2. Describir la CARA, que es lo que mas se recuerda: "ojos grandes redondos y
   oscuros con dos reflejos de luz, cejas finas, mejillas redondas".
3. Anadir ROPA y CALZADO concretos, siempre los mismos: "ropa de punto
   gris con rayas, zapatillas blancas con suela roja".
4. Dar PROPORCIONES: "cabeza grande, cuerpo pequeño, brazos cortos".
5. Mencionar UN detalle raro y fijo: "gorra blanca ladeada con un cherry
   bordado". Ese detalle es el que ata las tomas entre si.
6. Decir SIEMPRE "personaje de cuerpo entero" para que no salga un primer plano
   que luego no encaja con el plano siguiente.

Ejemplo correcto (copiar esta estructura):
"fresa roja con pepitas amarillas, ojos grandes redondos y oscuros con dos
reflejos de luz, cejas finas y rojas, sonrisa de lado, cuerpo de proportions
infantiles con cabeza enorme y brazos cortos, camiseta blanca con un They've
roto rojo bordado, vaqueros cortos, zapatillas blancas de suela roja,
gorra blanca ladeada con un cerebro bordado, personaje de cuerpo entero"

Ejemplo MALO (prohibido):
"fresa simpática" -- demasiado vago, el modelo inventara una distinta cada vez
"fresa roja" -- sin cara, sin ropa, sin detalle: no hay nada que mantener fijo

REGLA DE COHERENCIA

Todos los planos de la historia ocurren en el MISMO decorado y con el MISMO
vestuario. Anade a cada descripcion de plano el lugar donde ocurre, usando las
mismas palabras. Un "+lugar" al final de cada shotDescription.

Escribe el guion completo como JSON.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construccion del prompt de imagen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt de la imagen de referencia de un personaje: fondo neutro, cuerpo
 * entero, luz plana. Es una hoja de personaje, no una escena.
 */
export function buildCharacterSheetPrompt(character: Omit<Character, 'id' | 'referenceImagePath'>, styleId: string): string {
  const style = resolveStyle(styleId);
  const spec = ARCHETYPES[character.archetype];

  return (
    `Ficha de personaje para una pelicula animada. Un unico sujeto: ` +
    `un(a) ${character.species} llamado "${character.name}".\n\n` +
    `APARIENCIA: ${character.visualDescription}\n` +
    `ACTITUD: ${spec.visual}\n\n` +
    `ENCUADRE: plano entero, de frente, centrado, mirando a camara, ` +
    `manos visibles. Fondo liso de color neutro, sin objetos, sin texto, ` +
    `sin marcas de agua.\n\n` +
    `ESTILO: ${style.prompt}`
  );
}

/**
 * Prompt de un plano. Reinyecta la referencia visual de cada personaje
 * presente: es el mecanismo que sostiene la continuidad entre tomas.
 */
export function buildSceneImagePrompt(
  shotDescription: string,
  characters: Character[],
  styleId: string,
  visualStyle: string,
): string {
  const style = resolveStyle(styleId);

  const cast = characters.length
    ? characters
        .map((c) => `- ${c.name} (${c.species}): ${c.visualDescription}`)
        .join('\n')
    : '- Sin personajes definidos: usa objetos de cocina antropomorficos.';

  return (
    `PERSONAJES EN LA TOMA (reproduce estos rasgos EXACTAMENTE, es el mismo personaje en cada plano):\n${cast}\n\n` +
    `TOMA: ${shotDescription}\n\n` +
    `ENCUADRE: vertical 9:16, un solo plano, la accion congelada en su punto mas expresivo.\n` +
    `SUJETO: cuerpo entero visible de la cabeza a los pies, centrado, con espacio arriba y abajo.\n` +
    `DETALLE: ojos grandes y expresivos, ropa y calzado visibles, manos con dedos definidos.\n` +
    `ESTILO: ${visualStyle || style.prompt}\n` +
    `SIN TEXTO, SIN LOGOS, SIN MARCA DE AGUA.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Validacion de la respuesta del LLM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normaliza la respuesta cruda del LLM a un `Story` valido.
 *
 * Los modelos fallan de formas predecibles: envuelven el JSON en cercas de
 * codigo, anaden prosa antes o despues, o cortan el array a media estructura.
 * En vez de confiar en que salga limpio, se recorta lo recuperable y se completa
 * lo que falte con el arco por defecto.
 *
 * `preferredStyleId` es el estilo que pidio el usuario. Solo se usa si el modelo
 * no devuelve uno valido: el LLM puede mejorarlo, pero no debe descartarlo.
 */
export function parseStoryResponse(raw: string, storyId: string, preferredStyleId?: string): Story {
  const json = extractJson(raw);
  const data = JSON.parse(json) as RawStory;

  const now = new Date().toISOString();
  const characters: Character[] = (data.characters ?? []).map((c, i) => {
    const archetype = isArchetype(c.archetype) ? c.archetype : 'hero';
    return {
      id: `c${i + 1}`,
      name: c.name ?? `Personaje ${i + 1}`,
      species: c.species ?? 'fruta',
      archetype,
      visualDescription: c.visualDescription ?? '',
      personality: c.personality ?? '',
      voiceTone: c.voiceTone || ARCHETYPES[archetype].voiceTone,
    };
  });

  const rawScenes = data.scenes ?? [];
  const fallbackRoles = roleSequenceFor(rawScenes.length);

  const scenes: Scene[] = rawScenes.map((s, i) => ({
    id: `s${i + 1}`,
    index: i + 1,
    role: isSceneRole(s.role) ? s.role : (fallbackRoles[i] ?? 'setup'),
    narration: s.narration ?? '',
    shotDescription: s.shotDescription ?? '',
    characterIds: Array.isArray(s.characterIds) ? s.characterIds : [],
    targetDuration: s.role === 'hook' ? 4 : 10,
    variants: [],
    activeVariant: 0,
    attempts: 0,
    status: 'draft' as const,
  }));

  // El estilo del modelo manda, pero solo si existe en el catalogo. Si el
  // usuario eligio uno concreto y el modelo devolvio algo inventado, gana el
  // del usuario.
  const styleId = STYLES.some((s) => s.id === data.visualStyleId)
    ? data.visualStyleId!
    : preferredStyleId ?? DEFAULT_STYLE_ID;

  return {
    id: storyId,
    title: data.title ?? 'Frutinovela sin titulo',
    premise: data.premise ?? '',
    characters,
    scenes,
    visualStyleId: styleId,
    visualStyle: resolveStyle(styleId).prompt,
    tone: data.tone ?? 'melodramático',
    createdAt: now,
    updatedAt: now,
  };
}

/** Forma cruda que devuelve el LLM. No es un `Story`: le falta normalizar. */
interface RawStory {
  title?: string;
  premise?: string;
  visualStyleId?: string;
  tone?: string;
  characters?: {
    name?: string;
    species?: string;
    archetype?: string;
    visualDescription?: string;
    personality?: string;
    voiceTone?: string;
  }[];
  scenes?: {
    role?: string;
    narration?: string;
    shotDescription?: string;
    characterIds?: string[];
  }[];
}

function isArchetype(value: unknown): value is Archetype {
  return typeof value === 'string' && value in ARCHETYPES;
}

function isSceneRole(value: unknown): value is Scene['role'] {
  const roles: string[] = ['hook', 'setup', 'conflict', 'escalation', 'turn', 'cliffhanger', 'cta'];
  return typeof value === 'string' && roles.includes(value);
}

/** Recorta el primer objeto JSON balanceado del texto. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced?.[1] ?? raw;
  const start = text.indexOf('{');
  if (start === -1) throw new Error('La respuesta del modelo no contiene JSON.');

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('JSON desbalanceado en la respuesta del modelo.');
}