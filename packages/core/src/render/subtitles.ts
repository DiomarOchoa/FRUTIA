/**
 * Generacion de subtitulos al estilo TikTok.
 *
 * El formato que funciona en TikTok no es "subtitulo por frase" sino "una
 * palabra resaltada a la vez": el ojo persigue la palabra que suena y el
 * espectador lee sin esfuerzo. Eso se hace con ASS, no con SRT, porque ASS
 * soporta animacion por palabra.
 *
 * El problema es la alineacion temporal. No hay un forced aligner en el stack
 * (seria otra dependencia pesada), asi que el timing se aproxima de forma
 * deliberada: la duracion real del audio de la toma se reparte entre las
 * palabras proporcionalmente a su longitud, con un peso extra para las pausas.
 * El error resultante es de decenas de milisegundos, por debajo del umbral en
 * que el desfase se percibe.
 */

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
  /** Silencio estimado antes de la palabra, en segundos. */
  pauseAfter: number;
}

export interface CueTiming {
  /** Palabras agrupadas en una línea. Cada línea dura una sola palabra. */
  words: WordTiming[];
}

export interface SubtitleStyle {
  fontName: string;
  fontSize: number;
  primaryColor: string;   // ASS usa &HBBGGRR
  highlightColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadowDepth: number;
  marginVertical: number;
}

/** Estilo por defecto: blanco con palabra activa en amarillo, contorno grueso. */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontName: 'Arial',
  fontSize: 68,
  primaryColor: '&H00FFFFFF',
  highlightColor: '&H0049E0FF',
  outlineColor: '&H00101010',
  outlineWidth: 4,
  shadowDepth: 1,
  marginVertical: 220,
};

/** Palabras que nunca se resaltan solas: no aportan ritmo. */
const STOPWORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'que', 'en', 'a',
  'con', 'por', 'para', 'es', 'son', 'su', 'sus', 'lo', 'le', 'me', 'te',
  'se', 'si', 'no', 'ya', 'más', 'pero', 'como', 'muy',
]);

/** Fragmenta la narración en palabras, conservando la puntuación para el ritmo. */
export function tokenize(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Estima la duración de cada palabra proporcionalmente a su longitud.
 *
 * Las palabras cortas son mas lentas de pronunciar de lo que sugiere su
 * longitud, asi que se les aplica un factor: sin el ajuste, los articulos y
 * las preposiciones se "¿comen" el tiempo de la palabra que las sigue y el
 * desfase se acumula a lo largo de la toma.
 */
export function estimateWordTimings(text: string, totalDurationMs: number, offsetMs = 0): WordTiming[] {
  const words = tokenize(text);
  if (words.length === 0) return [];

  const weightOf = (w: string) => {
    const core = w.replace(/[^\p{L}\p{N}]/gu, '');
    const isStop = STOPWORDS.has(core.toLowerCase());
    return Math.max(1, core.length) * (isStop ? 1.6 : 1);
  };

  const weights = words.map(weightOf);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let cursor = offsetMs;
  return words.map((word, i) => {
    const share = (weights[i]! / totalWeight) * totalDurationMs;
    const startMs = cursor;
    const endMs = cursor + share;
    cursor = endMs;
    return {
      word,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      pauseAfter: /[.!?]$/.test(word) ? 0.25 : /[,;:]$/.test(word) ? 0.12 : 0.02,
    };
  });
}

/** Convierte milisegundos al formato de timestamp de ASS (H:MM:SS.cc). */
function assTimestamp(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
}

/** Format a short, centered caption with explicit line breaks for ASS. */
function formatContext(words: WordTiming[], activeIndex: number, style: SubtitleStyle): string {
  const from = Math.max(0, activeIndex - 2);
  const to = Math.min(words.length - 1, activeIndex + 2);
  const lines: { word: string; index: number }[][] = [[]];
  let lineLength = 0;

  for (let j = from; j <= to; j++) {
    const word = words[j]!.word;
    const current = lines[lines.length - 1]!;
    const nextLength = lineLength + (current.length ? 1 : 0) + word.length;
    if (current.length && nextLength > 24 && lines.length < 2) {
      lines.push([]);
      lineLength = 0;
    }
    const target = lines[lines.length - 1]!;
    lineLength += (target.length ? 1 : 0) + word.length;
    target.push({ word, index: j });
  }

  return lines
    .filter((line) => line.length)
    .map((line) => line.map(({ word, index }) => {
      const text = escapeAss(word);
      return index === activeIndex
        ? `{\\c${style.highlightColor}}${text}{\\c${style.primaryColor}}`
        : text;
    }).join(' '))
    .join('\\N');
}

/**
 * Genera un archivo ASS con la animacion palabra-a-palabra.
 *
 * Cada palabra se emite como un evento `Dialogue` propio, con la palabra
 * activa en color de resalte y un contexto breve envuelto en dos líneas.
 */
export function buildAss(
  cues: CueTiming[],
  style: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: 1080`,
    `PlayResY: 1920`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Pop',
      style.fontName,
      style.fontSize,
      style.primaryColor,
      style.highlightColor,
      style.outlineColor,
      '&H80000000',
      '-1', // negrita
      '0', '0', '0',
      '100', '100', '1', '0',
      '1', // BorderStyle outline
      String(style.outlineWidth),
      String(style.shadowDepth),
      '2', // alineacion inferior
      '80', '80', String(style.marginVertical),
      '1',
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  for (const cue of cues) {
    for (let i = 0; i < cue.words.length; i++) {
      const w = cue.words[i]!;
      // Timings are contiguous: overlapping events draw duplicate captions.
      const activeStart = w.startMs;
      const activeEnd = Math.max(w.endMs, w.startMs + 40);
      const caption = formatContext(cue.words, i, style);

      events.push(
        `Dialogue: 0,${assTimestamp(activeStart)},${assTimestamp(activeEnd)},Pop,,0,0,0,,${caption}`,
      );
    }
  }

  return [...header, ...events, ''].join('\n');
}

/** Atajo: texto + duración -> cues con tiempos estimados. */
export function cuesFromScene(text: string, durationMs: number, offsetMs = 0): CueTiming {
  return { words: estimateWordTimings(text, durationMs, offsetMs) };
}
