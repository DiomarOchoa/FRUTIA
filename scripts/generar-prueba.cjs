/**
 * Genera 3 frutinovelas de prueba sin APIs externas.
 * Usa imágenes procedurales locales + voz Piper + render ffmpeg.
 */
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { TtsProvider, composeFinal } = require('../packages/core/dist/index.js');

// Carga .env (ahi estan PIPER_BIN y PIPER_MODEL)
const envPath = path.resolve(__dirname, '..', '.env');
try {
  const envText = require('node:fs').readFileSync(envPath, 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
} catch {}

const STORAGE = path.resolve(__dirname, '..', 'storage');

const guiones = [
  {
    title: 'La fresa y el mentiroso',
    characters: [
      { id: 'c1', name: 'Fresita', species: 'fresa', archetype: 'hero', visualDescription: 'fresa roja', voiceTone: 'femenina-joven', personality: 'noble' },
      { id: 'c2', name: 'Ciruelo', species: 'ciruela', archetype: 'villain', visualDescription: 'ciruela morada', voiceTone: 'masculina-media', personality: 'calculador' },
    ],
    scenes: [
      { role: 'hook', narration: 'Fresita: Nunca imagine que el amor me doleria tanto. Ciruelo: Pero si todo era mentira.', shotDescription: 'cocina', color: '#FF4444' },
      { role: 'setup', narration: 'Fresita: Ciruelo juro que solo tenia amistad con la piña nueva.', shotDescription: 'cocina', color: '#8B0000' },
      { role: 'conflict', narration: 'Fresita: Pero yo vi los mensajes en su telefono anoche.', shotDescription: 'sala', color: '#FF6B6B' },
      { role: 'escalation', narration: 'Fresita: Me dijiste que la odias, que es una arruinada.', shotDescription: 'sala', color: '#CC0000' },
      { role: 'turn', narration: 'Fresita: Entonces todo lo que me contaste era mentira.', shotDescription: 'puerta', color: '#990000' },
      { role: 'cliffhanger', narration: 'Fresita: Ya no quiero escucharte. Ciruelo: ¿Y la piña?', shotDescription: 'puerta', color: '#660000' },
    ],
  },
  {
    title: 'Las piñas del mercado',
    characters: [
      { id: 'c1', name: 'PiñaMayor', species: 'piña', archetype: 'boss', visualDescription: 'piña dorada', voiceTone: 'femenina-grave', personality: 'dominante' },
      { id: 'c2', name: 'PiñaNueva', species: 'piña', archetype: 'naive', visualDescription: 'piña joven', voiceTone: 'femenina-juvenil', personality: 'confiada' },
    ],
    scenes: [
      { role: 'hook', narration: 'PiñaMayor: Llevo diez años vendiendo en este mercado.', shotDescription: 'mercado', color: '#FFD700' },
      { role: 'setup', narration: 'PiñaNueva: Y yo acabo de llegar, con mejores precios.', shotDescription: 'mercado', color: '#FFA500' },
      { role: 'conflict', narration: 'PiñaMayor: Aquí la clientela es mía, nadie me quita mis puestos.', shotDescription: 'puesto', color: '#DAA520' },
      { role: 'escalation', narration: 'PiñaNueva: El mercado es de todos, señora.', shotDescription: 'puesto', color: '#B8860B' },
      { role: 'turn', narration: 'PiñaNueva: Ya firmaron conmigo los otros vendedores.', shotDescription: 'papel', color: '#8B6914' },
      { role: 'cliffhanger', narration: 'PiñaMayor: Esto no se queda así.', shotDescription: 'puesto', color: '#5C4033' },
    ],
  },
  {
    title: 'La sandía y su enemiga',
    characters: [
      { id: 'c1', name: 'Sandía', species: 'sandía', archetype: 'hero', visualDescription: 'sandía verde', voiceTone: 'femenina-media', personality: 'valiente' },
      { id: 'c2', name: 'PiñaEnemiga', species: 'piña', archetype: 'rival', visualDescription: 'piña dorada', voiceTone: 'femenina-media', personality: 'ambiciosa' },
    ],
    scenes: [
      { role: 'hook', narration: 'Sandía: Toda la vida creí que la piña era mi peor enemiga.', shotDescription: 'campo', color: '#228B22' },
      { role: 'setup', narration: 'PiñaEnemiga: Y lo fui, hasta ayer, cuando pasó lo impensable.', shotDescription: 'campo', color: '#32CD32' },
      { role: 'conflict', narration: 'PiñaEnemiga: Mi hermana se enfermó por una sandía podrida que tú vendiste.', shotDescription: 'campo', color: '#006400' },
      { role: 'escalation', narration: 'Sandía: Yo jamás vendí sandías podridas, eso es mentira.', shotDescription: 'campo', color: '#2E8B57' },
      { role: 'turn', narration: 'PiñaEnemiga: Pensé que lo hiciste a propósito por odio.', shotDescription: 'campo', color: '#3CB371' },
      { role: 'cliffhanger', narration: 'Sandía: Ya no puedo seguir odiándote, ¿qué hacemos?', shotDescription: 'mano', color: '#90EE90' },
    ],
  },
];

async function imagenProc(color, texto, outPath) {
  const ffmpeg = require('ffmpeg-static');
  const tmp = path.join(os.tmpdir(), `frutia-img-${Date.now()}.png`);
  // PNG solido de 1080x1920 via ffmpeg
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1080x1920:d=1`, '-frames:v', '1', tmp], { stdio: 'ignore' });
  await fs.copyFile(tmp, outPath);
  await fs.unlink(tmp).catch(() => {});
}

async function generarFrutinovela(g, idx) {
  console.log(`\n=== FRUTINOVELA ${idx + 1}: ${g.title} ===`);
  const story = {
    id: `prueba-${Date.now()}-${idx}`,
    title: g.title,
    premise: g.scenes[0].narration,
    characters: g.characters,
    scenes: g.scenes.map((s, i) => ({
      id: `s${i + 1}`,
      index: i + 1,
      role: s.role,
      narration: s.narration,
      shotDescription: s.shotDescription,
      color: s.color,
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

  // Imágenes
  console.log('  Imágenes...');
  for (const scene of story.scenes) {
    const imgPath = path.join(deps.storageDir, 'scenes', `${scene.id}-v0.png`);
    await fs.mkdir(path.dirname(imgPath), { recursive: true });
    await imagenProc(scene.color, scene.shotDescription, imgPath);
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
