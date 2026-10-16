/**
 * Convierte el prompt largo de Frutia (pensado para Gemini/Flux) en uno corto
 * que Stable Diffusion 1.5 pueda aprovechar.
 *
 * Por qué hace falta:
 *  - SD 1.5 usa CLIP, que solo lee ~77 tokens y solo entiende inglés. El prompt
 *    original tiene cientos de tokens: lo importante (la escena y el estilo)
 *    queda cortado y lo que sobrevive es el principio de la lista de reglas.
 *  - El prompt dice "No humans, no people..." en positivo. En CLIP las palabras
 *    cuentan aunque estén negadas: nombrar "humans" las invita a aparecer.
 *    Esas prohibiciones ya van en el prompt negativo, que es donde funcionan.
 *  - La escena llega en español; CLIP no la entiende. Se traducen unas pocas
 *    pistas (lugar, emoción, objeto) con un diccionario pequeño.
 */

const DEFAULT_STYLE =
  '3d animated movie still, pixar style, soft lighting, vibrant colors';

const STYLE_TAGS: Array<[RegExp, string]> = [
  [/pixel/i, 'pixel art, 16-bit game sprite, limited palette'],
  [/clay|plastilina|claymation/i, 'claymation, plasticine, stop motion, soft lighting'],
];

type CueKind = 'place' | 'time' | 'emotion' | 'prop';

/**
 * Pistas es -> en. Se comparan contra el texto sin tildes y en minúsculas.
 * Solo se usa UNA por categoría (la que aparece primero en la escena): varias
 * emociones o lugares a la vez confunden a CLIP y producen mezclas.
 */
const CUES: Array<[CueKind, RegExp, string]> = [
  ['place', /mercado|puesto|feria/, 'fruit market'],
  ['place', /cocina/, 'kitchen'],
  ['place', /huerto|cultivo/, 'orchard'],
  ['place', /jardin/, 'garden'],
  ['place', /bosque|selva/, 'forest'],
  ['place', /playa|\bmar\b/, 'beach'],
  ['place', /escuela|colegio|salon/, 'classroom'],
  ['place', /casa|\bsala\b|habitacion|cuarto/, 'cozy house interior'],
  ['place', /calle|plaza|ciudad/, 'town street'],
  ['place', /fiesta|baile|celebra/, 'party, confetti'],
  ['place', /boda|altar/, 'wedding'],
  ['place', /tribunal|juicio/, 'courtroom'],
  ['time', /noche|luna/, 'night, moonlight'],
  ['time', /lluvia|tormenta/, 'rain'],
  ['time', /atardecer|amanecer/, 'sunset, golden light'],
  ['prop', /carta|\bsobre\b/, 'holding a letter'],
  ['prop', /corona/, 'golden crown'],
  ['prop', /puerta/, 'doorway'],
  ['emotion', /llor|lagrima|triste|dolor/, 'sad'],
  ['emotion', /sonri|feliz|alegr|contenta|content[oa]/, 'happy'],
  ['emotion', /enoj|furios|\bira\b|grit/, 'angry'],
  ['emotion', /sorprend|asombr|confund|impact/, 'surprised'],
  ['emotion', /mied|asust|terror|temblan/, 'scared'],
  ['emotion', /culpab|verguenza/, 'guilty'],
  ['emotion', /abraz/, 'hugging'],
];

/** Una pista por categoría: la que aparece antes en el texto de la escena. */
function pickCues(sceneText: string): string[] {
  const text = plain(sceneText);
  const best = new Map<CueKind, { at: number; tag: string }>();
  for (const [kind, re, tag] of CUES) {
    const at = text.search(re);
    if (at < 0) continue;
    const current = best.get(kind);
    if (!current || at < current.at) best.set(kind, { at, tag });
  }
  return (['place', 'time', 'prop', 'emotion'] as const).flatMap((kind) => best.get(kind)?.tag ?? []);
}

const FALLBACK_FRUIT = 'fruit';

function plain(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function toClipPrompt(prompt: string): string {
  const styleText = /STYLE:\s*([\s\S]*)$/.exec(prompt)?.[1] ?? '';
  const style = STYLE_TAGS.find(([re]) => re.test(styleText))?.[1] ?? DEFAULT_STYLE;

  // "- NAME, an anthropomorphic strawberry:" -> strawberry. Máximo 2: SD 1.5
  // duplica o fusiona personajes cuando hay más. Si hay más de 2 en el reparto,
  // van primero los que la escena nombra de verdad.
  const sceneText = /SCENE:\s*([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] ?? '';
  const named = plain(sceneText);
  const cast = [...prompt.matchAll(/-\s*([^,\n]+),\s*an anthropomorphic ([a-z]+(?: [a-z]+)?)(?=[:.,\n])/gi)].map((m) => ({
    name: plain(m[1] ?? '').trim(),
    fruit: (m[2] ?? '').toLowerCase(),
  }));
  const ordered = [...cast.filter((c) => c.name && named.includes(c.name)), ...cast.filter((c) => !c.name || !named.includes(c.name))];
  let fruits = unique(ordered.map((c) => c.fruit)).slice(0, 2);
  if (fruits.length === 0) {
    // Hoja de personaje: "One character only: NAME, an anthropomorphic FRUIT."
    const single = /an anthropomorphic ([a-z]+(?: [a-z]+)?)(?=[:.,\n])/i.exec(prompt)?.[1];
    if (single) fruits = [single.toLowerCase()];
  }

  const subject =
    fruits.length >= 2
      ? `two cute fruit characters, a ${fruits[0]} and a ${fruits[1]}, standing apart, big eyes, cartoon faces, small arms and legs`
      : `one cute ${fruits[0] ?? FALLBACK_FRUIT} character, fruit body, big eyes, cartoon face, small arms and legs`;

  const isSheet = /Character design sheet/i.test(prompt);
  const cues = isSheet ? [] : pickCues(sceneText);

  const framing = isSheet
    ? 'full body, front view, standing, plain white background'
    : 'full body, centered, simple clean background';

  return [style, subject, ...cues, framing, 'best quality'].join(', ');
}

export const COMFY_NEGATIVE_PROMPT =
  'human, person, woman, man, girl, boy, realistic human skin, portrait, photograph, live action, ' +
  'mascot suit, fruit costume, hat, clothes on a human body, deformed, malformed anatomy, extra limbs, ' +
  'extra heads, duplicate character, clones, multiple views, collage, split screen, extra people, ' +
  'cropped, out of frame, blurry, low quality, text, logo, watermark';
