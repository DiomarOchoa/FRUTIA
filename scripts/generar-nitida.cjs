/**
 * Genera frutinovelas nitidas sin APIs externas.
 * Escenas procedurales 1080x1920 + voz Piper + subtitulos + render ffmpeg.
 */
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { TtsProvider, composeFinal } = require('../packages/core/dist/index.js');

// Carga .env
try {
  const envText = require('node:fs').readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
} catch {}

const STORAGE = path.resolve(__dirname, '..', 'storage');
const W = 1080, H = 1920;

/**
 * Pinta una escena con ffmpeg: fondo con luz de ventana, mesa de comida,
 * y dos personajes (frutas con cara) con expresiones distintas.
 */
function pintarEscena({ fondo, luz, frutaA, exprA, frutaB, exprB, mesa }) {
  const filtros = [];

  // Fondo: gradiente oscuro + luz de ventana calida
  filtros.push(`gradients=s=${W}x${H}:c0=${fondo}:c1=${luz}:x0=0:y0=0:x1=${W}:y1=${H}:speed=0`);

  // Mesa de comida (parte inferior)
  if (mesa) {
    filtros.push(`drawbox=x=0:y=${Math.round(H * 0.72)}:w=${W}:h=${H}:color=0x3a2a1a:t=fill`);
    filtros.push(`drawbox=x=0:y=${Math.round(H * 0.70)}:w=${W}:h=${Math.round(H * 0.025)}:color=0x8a6a4a:t=fill`);
    // Platos
    filtros.push(`drawellipse=cx=${Math.round(W * 0.3)}:cy=${Math.round(H * 0.78)}:rx=120:ry=40:color=0xd0d0d0:t=fill`);
    filtros.push(`drawellipse=cx=${Math.round(W * 0.7)}:cy=${Math.round(H * 0.78)}:rx=120:ry=40:color=0xd0d0d0:t=fill`);
    // Comida en platos
    filtros.push(`drawellipse=cx=${Math.round(W * 0.3)}:cy=${Math.round(H * 0.78)}:rx=90:ry=28:color=0xc84020:t=fill`);
    filtros.push(`drawellipse=cx=${Math.round(W * 0.7)}:cy=${Math.round(H * 0.78)}:rx=90:ry=28:color=0xd0a020:t=fill`);
  }

  // Personaje A (izquierda) - silueta de fruta con cara
  const ax = Math.round(W * 0.28), ay = Math.round(H * 0.42), ar = 180;
  filtros.push(`drawbox=x=${ax - ar}:y=${ay - ar}:w=${ar * 2}:h=${ar * 2}:color=${frutaA}:t=fill@0.92`);
  // Ojos
  filtros.push(`drawellipse=cx=${ax - 60}:cy=${ay - 40}:rx=45:ry=55:color=0xffffff:t=fill`);
  filtros.push(`drawellipse=cx=${ax + 60}:cy=${ay - 40}:rx=45:ry=55:color=0xffffff:t=fill`);
  // Pupilas
  const pupilaY = exprA === 'triste' ? -20 : exprA === 'enojado' ? 10 : 0;
  filtros.push(`drawellipse=cx=${ax - 55}:cy=${ay - 40 + pupilaY}:rx=22:ry=28:color=0x101020:t=fill`);
  filtros.push(`drawellipse=cx=${ax + 55}:cy=${ay - 40 + pupilaY}:rx=22:ry=28:color=0x101020:t=fill`);
  // Boca segun expresion
  if (exprA === 'feliz') {
    filtros.push(`drawbox=x=${ax - 70}:y=${ay + 60}:w=140:h=30:color=0x202020:t=fill`);
    filtros.push(`drawbox=x=${ax - 50}:y=${ay + 90}:w=100:h=20:color=0x202020:t=fill`);
  } else if (exprA === 'triste') {
    filtros.push(`drawbox=x=${ax - 60}:y=${ay + 80}:w=120:h=20:color=0x202020:t=fill`);
  } else {
    filtros.push(`drawbox=x=${ax - 70}:y=${ay + 70}:w=140:h=18:color=0x202020:t=fill`);
  }
  // Hoja en la cabeza
  filtros.push(`drawbox=x=${ax - 30}:y=${ay - ar - 40}:w=60:h=50:color=0x228b22:t=fill@0.9`);

  // Personaje B (derecha)
  const bx = Math.round(W * 0.72), by = Math.round(H * 0.42);
  filtros.push(`drawbox=x=${bx - ar}:y=${by - ar}:w=${ar * 2}:h=${ar * 2}:color=${frutaB}:t=fill@0.92`);
  filtros.push(`drawellipse=cx=${bx - 60}:cy=${by - 40}:rx=45:ry=55:color=0xffffff:t=fill`);
  filtros.push(`drawellipse=cx=${bx + 60}:cy=${by - 40}:rx=45:ry=55:color=0xffffff:t=fill`);
  const pupilaBY = exprB === 'triste' ? -20 : exprB === 'enojado' ? 10 : 0;
  filtros.push(`drawellipse=cx=${bx - 55}:cy=${by - 40 + pupilaBY}:rx=22:ry=28:color=0x101020:t=fill`);
  filtros.push(`drawellipse=cx=${bx + 55}:cy=${by - 40 + pupilaBY}:rx=22:ry=28:color=0x101020:t=fill`);
  if (exprB === 'feliz') {
    filtros.push(`drawbox=x=${bx - 70}:y=${by + 60}:w=140:h=30:color=0x202020:t=fill`);
    filtros.push(`drawbox=x=${bx - 50}:y=${by + 90}:w=100:h=20:color=0x202020:t=fill`);
  } else if (exprB === 'triste') {
    filtros.push(`drawbox=x=${bx - 60}:y=${by + 80}:w=120:h=20:color=0x202020:t=fill`);
  } else {
    filtros.push(`drawbox=x=${bx - 70}:y=${by + 70}:w=140:h=18:color=0x202020:t=fill`);
  }
  filtros.push(`drawbox=x=${bx - 30}:y=${by - ar - 40}:w=60:h=50:color=0x228b22:t=fill@0.9`);

  return filtros.join(',');
}

const guiones = [
  {
    title: 'La fresa y el mentiroso',
    characters: [
      { id: 'c1', name: 'Fresita', species: 'fresa', archetype: 'hero', visualDescription: 'fresa roja', voiceTone: 'femenina-joven', personality: 'noble' },
      { id: 'c2', name: 'Ciruelo', species: 'ciruela', archetype: 'villain', visualDescription: 'ciruela morada', voiceTone: 'masculina-media', personality: 'calculador' },
    ],
    scenes: [
      { role: 'hook', narration: 'Fresita: Nunca imagine que el amor me doleria tanto.', exprA: 'triste', exprB: 'feliz' },
      { role: 'setup', narration: 'Fresita: Ciruelo juro que solo tenia amistad con la piña nueva.', exprA: 'enojado', exprB: 'feliz' },
      { role: 'conflict', narration: 'Fresita: Pero yo vi los mensajes en su telefono anoche.', exprA: 'enojado', exprB: 'triste' },
      { role: 'escalation', narration: 'Fresita: Me dijiste que la odias, que es una arruinada.', exprA: 'triste', exprB: 'enojado' },
      { role: 'turn', narration: 'Fresita: Entonces todo lo que me contaste era mentira.', exprA: 'triste', exprB: 'triste' },
      { role: 'cliffhanger', narration: 'Fresita: Ya no quiero escucharte. Ciruelo: ¿Y la piña?', exprA: 'enojado', exprB: 'triste' },
    ],
  },
  {
    title: 'Las piñas del mercado',
    characters: [
      { id: 'c1', name: 'PiñaMayor', species: 'piña', archetype: 'boss', visualDescription: 'piña dorada', voiceTone: 'femenina-grave', personality: 'dominante' },
      { id: 'c2', name: 'PiñaNueva', species: 'piña', archetype: 'naive', visualDescription: 'piña joven', voiceTone: 'femenina-juvenil', personality: 'confiada' },
    ],
    scenes: [
      { role: 'hook', narration: 'PiñaMayor: Llevo diez años vendiendo en este mercado.', exprA: 'enojado', exprB: 'feliz' },
      { role: 'setup', narration: 'PiñaNueva: Y yo acabo de llegar, con mejores precios.', exprA: 'enojado', exprB: 'feliz' },
      { role: 'conflict', narration: 'PiñaMayor: Aquí la clientela es mía, nadie me quita mis puestos.', exprA: 'enojado', exprB: 'triste' },
      { role: 'escalation', narration: 'PiñaNueva: El mercado es de todos, señora.', exprA: 'triste', exprB: 'enojado' },
      { role: 'turn', narration: 'PiñaNueva: Ya firmaron conmigo los otros vendedores.', exprA: 'enojado', exprB: 'feliz' },
      { role: 'cliffhanger', narration: 'PiñaMayor: Esto no se queda así.', exprA: 'enojado', exprB: 'triste' },
    ],
  },
  {
    title: 'La sandía y su enemiga',
    characters: [
      { id: 'c1', name: 'Sandía', species: 'sandía', archetype: 'hero', visualDescription: 'sandía verde', voiceTone: 'femenina-media', personality: 'valiente' },
      { id: 'c2', name: 'PiñaEnemiga', species: 'piña', archetype: 'rival', visualDescription: 'piña dorada', voiceTone: 'femenina-media', personality: 'ambiciosa' },
    ],
    scenes: [
      { role: 'hook', narration: 'Sandía: Toda la vida creí que la piña era mi peor enemiga.', exprA: 'triste', exprB: 'enojado' },
      { role: 'setup', narration: 'PiñaEnemiga: Y lo fui, hasta ayer, cuando pasó lo impensable.', exprA: 'triste', exprB: 'triste' },
      { role: 'conflict', narration: 'PiñaEnemiga: Mi hermana se enfermó por una sandía podrida que tú vendiste.', exprA: 'enojado', exprB: 'triste' },
      { role: 'escalation', narration: 'Sandía: Yo jamás vendí sandías podridas, eso es mentira.', exprA: 'enojado', exprB: 'triste' },
      { role: 'turn', narration: 'PiñaEnemiga: Pensé que lo hiciste a propósito por odio.', exprA: 'triste', exprB: 'triste' },
      { role: 'cliffhanger', narration: 'Sandía: Ya no puedo seguir odiándote, ¿qué hacemos?', exprA: 'triste', exprB: 'triste' },
    ],
  },
];

async function generarFrutinovela(g, idx) {
  console.log(`\n=== FRUTINOVELA ${idx + 1}: ${g.title} ===`);
  const story = {
    id: `nitida-${Date.now()}-${idx}`,
    title: g.title,
    premise: g.scenes[0].narration,
    characters: g.characters,
    scenes: g.scenes.map((s, i) => ({
      id: `s${i + 1}`,
      index: i + 1,
      role: s.role,
      narration: s.narration,
      shotDescription: s.shotDescription || '',
      characterIds: ['c1'],
      targetDuration: s.role === 'hook' ? 4 : 10,
      variants: [],
      activeVariant: 0,
      attempts: 0,
      status: 'generated',
    })),
    visualStyleId: 'pixar3d',
    visualStyle: '',
    tone: 'melodramatico',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const tts = new TtsProvider({ apiKey: '', defaultVoice: 'Puck' });
  const deps = { llm: null, image: null, tts, storageDir: path.join(STORAGE, story.id) };

  const ffmpeg = require('ffmpeg-static');

  // Imágenes
  console.log('  Imágenes...');
  for (const scene of story.scenes) {
    const imgPath = path.join(deps.storageDir, 'scenes', `${scene.id}-v0.png`);
    await fs.mkdir(path.dirname(imgPath), { recursive: true });
    const filtro = pintarEscena({
      fondo: '#1a0f08', luz: '#ffcc88',
      frutaA: scene.role === 'cliffhanger' ? '#cc2222' : '#dd3333',
      exprA: scene.exprA || 'feliz',
      frutaB: scene.role === 'cliffhanger' ? '#8844cc' : '#aa3333',
      exprB: scene.exprB || 'feliz',
      mesa: true,
    });
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1`, '-vf', filtro, '-frames:v', '1', '-update', '1', imgPath], { stdio: 'ignore' });
    scene.variants = [imgPath];
    scene.activeVariant = 0;
  }

  // Voz
  console.log('  Voz...');
  for (const scene of story.scenes) {
    const { base64, extension } = await tts.speak({ text: scene.narration });
    const audioPath = path.join(deps.storageDir, 'audio', `${scene.id}.${extension}`);
    await fs.mkdir(path.dirname(audioPath), { recursive: true });
    await fs.writeFile(audioPath, Buffer.from(base64, 'base64'));
    scene.audioPath = audioPath;
    scene.targetDuration = 10;
  }

  // Render
  console.log('  Render...');
  const outputPath = await composeFinal(deps, story, { quality: 'standard', requireApproval: false });
  const { statSync } = require('node:fs');
  const kb = (statSync(outputPath).size / 1024).toFixed(0);
  console.log(`  OK: ${outputPath} (${kb} KB)`);
  return outputPath;
}

(async () => {
  for (let i = 0; i < guiones.length; i++) {
    try {
      await generarFrutinovela(guiones[i], i);
    } catch (e) {
      console.error(`  ERROR ${i + 1}:`, e.message);
    }
  }
  console.log('\n=== TERMINADO ===');
  process.exit(0);
})();
