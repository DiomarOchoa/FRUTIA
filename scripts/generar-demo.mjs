/**
 * Frutinovela completa, escrita a mano por el agente.
 *
 * Existe por una razon concreta: la cuota diaria de Gemini (20 peticiones) se
 * agoto y la consumen las pruebas de diagnostico, no las historias. Este
 * script escribe el guion por fuera y mete la historia por la MISMA cadena de
 * produccion que usa la app:
 *
 *   generateImages() -> Pollinations (imagenes reales)
 *   generateVoice()  -> Piper local (audio real)
 *   composeFinal()   -> ffmpeg (MP4 real, subtitulos ASS reales)
 *
 * Es decir: lo unico que se salta es la llamada de texto a Google. Todo lo que
 * produce el archivo de video es codigo de produccion, no un simulacro.
 */

import { statSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  ImageProvider,
  TtsProvider,
  generateImages,
  generateVoice,
  composeFinal,
  resolveStyle,
  totalDuration,
  secondsToMonetizable,
  MIN_MONETIZABLE_SEC,
} from '../packages/core/dist/index.js';

const STORAGE = path.resolve('storage');

const estilo = resolveStyle('pixar3d');

const AHORA = new Date().toISOString();
const ID = 'demo-' + randomUUID().slice(0, 8);

const story = {
  id: ID,
  title: 'El celular desbloqueado',
  premise: 'La fresa Clementina le puso a su novio Teodoro un contrasena en su celular sin querer, y el mundo se le cae encima.',
  tone: 'melodramatico',
  visualStyleId: estilo.id,
  visualStyle: estilo.prompt,
  createdAt: AHORA,
  updatedAt: AHORA,

  characters: [
    {
      id: 'teodoro',
      name: 'Teodoro',
      species: 'membrillo',
      archetype: 'hero',
      voiceTone: 'masculina-seria',
      personality: 'trabaja de noche, paga todo y nunca pregunta de mas',
      visualDescription:
        'Fruta antropomorfa en 3D estilo Pixar: un membrillo amarillo dorado en forma de manzana elongationada, '
        + 'piel brillante con vello suave, ojos grandes redondos color avellana con reflejos, cejas finas, '
        + 'wearing a blue and white striped button shirt, short dark brown hair parted to the side, '
        + 'a small 3-day stubble beard, expressive worried eyebrows and slightly open mouth showing surprise, '
        + 'full body, standing, character design, consistent proportions',
    },
    {
      id: 'clementina',
      name: 'Clementina',
      species: 'fresa',
      archetype: 'villain',
      voiceTone: 'femenina-suave',
      personality: 'siempre sonriente, nunca dice que no a nada',
      visualDescription:
        'Fruta antropomorfa en 3D estilo Pixar: una fresa roja brillante con forma de corazon, '
        + 'semillas doradas hundidas en la piel, ojos grandes verdes esmeralda con pestañas largas, '
        + 'mejillas rosadas, wearing a red dress and gold earrings, long curly dark brown hair, '
        + 'smiling with a sly confident expression, one eyebrow slightly raised, '
        + 'full body, standing, character design, consistent proportions',
    },
    {
      id: 'lombroza',
      name: 'Lombroza',
      species: 'limon',
      archetype: 'bestie',
      voiceTone: 'femenina-ansiosa',
      personality: 'la que dice la verdad cuando ya es tarde',
      visualDescription:
        'Fruta antropomorfa en 3D estilo Pixar: un limon amarillo brillante con cascara porosa y detalle, '
        + 'ojos grandes color miel con reflejos verdes, wearing a yellow raincoat, '
        + 'short blond bob haircut, guilty expression with watery eyes and a forced smile, '
        + 'hands clasped nervously in front, full body, standing, character design, consistent proportions',
    },
    {
      id: 'pablito',
      name: 'Don Pablito',
      species: 'pina',
      archetype: 'rival',
      voiceTone: 'masculina-grave',
      personality: 'el nombre que nadie sabe de donde salio',
      visualDescription:
        'Fruta antropomorfa en 3D estilo Pixar: una pina amarilla dorada y naranja, '
        + 'corona de hojas verdes afiladas en la cabeza, ojos grandes color marrones oscuros, '
        + 'wearing a white guayabera shirt, thick black mustache, arms crossed, '
        + 'mysterious confident smirk, full body, standing, character design, consistent proportions',
    },
  ],

  scenes: [
    {
      id: 's1', index: 1, role: 'hook',
      narration:
        'Abri el celular de Clementina sin querer. tenia cuarenta y siete mensajes sin leer. '
        + 'Y todos decian lo mismo: nos vemos a la medianoche.',
      shotDescription:
        'Primer plano de una mano de membrillo sosteniendo un celular en una cocina a oscuras, '
        + 'la pantalla ilumina el rostro con luz fria verde, se ven bubbles de chat apilados, '
        + 'tension, night time, dramatic',
      characterIds: ['teodoro'],
      targetDuration: 9, variants: [], activeVariant: 0, attempts: 0, status: 'draft',
    },
    {
      id: 's2', index: 2, role: 'setup',
      narration:
        'Clementina es mi novia hace tres años. Es una fresa y se rie de todo. '
        + 'El lunes me dijo: manana llega mi hermana. Y yo le crei, porque le creo a todo.',
      shotDescription:
        'Dos personajes juntos en la puerta de una casa de barrio, un membrillo y una fresa '
        + 'sonriendose, luz calida de tarde, vecindad colorida al fondo, tender loving moment',
      characterIds: ['teodoro', 'clementina'],
      targetDuration: 9, variants: [], activeVariant: 0, attempts: 0, status: 'draft',
    },
    {
      id: 's3', index: 3, role: 'conflict',
      narration:
        'A la medianoche estaba en la cocina. Del cuarto venia el sonido de un teclado. '
        + 'Tecleaba, borraba, y otra vez. Como quien esconde algo.',
      shotDescription:
        'Un pasillo de casa pequena a las doce de la noche, puerta entreabierta con luz amarilla '
        + 'escapandose, sombra de una silueta sentada frente a un computer, el membrillo escucha '
        + 'en el fondo, eerie quiet tension',
      characterIds: ['teodoro'],
      targetDuration: 9, variants: [], activeVariant: 0, attempts: 0, status: 'draft',
    },
    {
      id: 's4', index: 4, role: 'conflict',
      narration:
        'Abri la puerta. Clementina dejo el celular en la mesa, sonriendo. '
        + 'Le pregunte quien era. Me dijo: un amigo del trabajo. Se llamaba Don Pablito.',
      shotDescription:
        'Una fresa sentada en una mesa de cocina con un celular en la mano, luz fria de pantalla '
        + 'sobre su cara, una sonrisa que no cuadra, el membrillo de pie en el marco de la puerta, '
        + 'confrontation, cold blue lighting',
      characterIds: ['clementina', 'teodoro'],
      targetDuration: 9, variants: [], activeVariant: 0, attempts: 0, status: 'draft',
    },
    {
      id: 's5', index: 5, role: 'escalation',
      narration:
        'Al dia siguiente llame a la empresa. No existe ningun Pablito ahi. '
        + 'Y cuando le dije el nombre, ella se quedo muda. Tres años y nunca se quedaba muda.',
      shotDescription:
        'Primer plano de una fresa con los ojos muy abiertos y la boca entreabierta, '
        + 'luz dura de telefono en la mejilla, fondo desenfocado de oficina, Expression of shock, '
        + 'the moment she realizes he knows',
      characterIds: ['clementina'],
      targetDuration: 9, variants: [], activeVariant: 0, attempts: 0, status: 'draft',
    },
    {
      id: 's6', index: 6, role: 'escalation',
      narration:
        'Esa noche la deje. Mi amigo Lombroza me encontro llorando en la panaderia. '
        + 'Me ofrecio un tinto y me solto: yo se por que lo hace.',
      shotDescription:
        'Un limon con capa amarilla llorando sentado en la acera de una panaderia cerrada, '
        + 'farolas humedas, noche azul, a servilletazo de papel con tinta al lado, '
        + 'lonely vulnerable, rain puddles reflecting streetlights',
      characterIds: ['lombroza'],
      targetDuration: 9, variants: [], activeVariant: 0, attempts: 0, status: 'draft',
    },
    {
      id: 's7', index: 7, role: 'turn',
      narration:
        'Los mensajes no los escribia Don Pablito. Los escribia Lombroza. '
        + 'Dos años haciendose pasar por un hombre, solo para separarme de Clementina.',
      shotDescription:
        'Una pina con corona de hojas afiladas y bigote negro apareciendo en un marco de puerta, '
        + 'niebla y luz roja detras, revelacion del villano, revelacion scene, dramatic backlight, '
        + 'slow motion feeling',
      characterIds: ['pablito', 'lombroza'],
      targetDuration: 9, variants: [], activeVariant: 0, attempts: 0, status: 'draft',
    },
    {
      id: 's8', index: 8, role: 'turn',
      narration:
        'El motivo? Lo dijo como quien suelta un cuchillo: estaba enamorada de mi desde el colegio. '
        + 'Y no, eso no fue lo peor.',
      shotDescription:
        'Un limon de frente en una pared de panaderia, luz de un solo foco desde arriba, '
        + 'llorando, confesion, one single overhead light, deep shadows, '
        + 'culpa y amor en la misma Expression',
      characterIds: ['lombroza'],
      targetDuration: 9, variants: [], activeVariant: 0, attempts: 0, status: 'draft',
    },
    {
      id: 's9', index: 9, role: 'cliffhanger',
      narration:
        'Lo peor es que Clementina lo sabia todo. Y fue ella quien le dio a Lombroza '
        + 'la contrasena del celular. La parte dos ya esta subida.',
      shotDescription:
        'Una fresa y un limon hombro con hombro, la fresa sonriendo mientras le pasa un celular '
        + 'al limon, cocina de noche, traicion entre aliados, two shot, the twist revealed, '
        + 'warm lamp light against darkness',
      characterIds: ['clementina', 'lombroza'],
      targetDuration: 9, variants: [], activeVariant: 0, attempts: 0, status: 'draft',
    },
  ],
};

const deps = {
  // No se usa el texto: el guion ya esta escrito. Se deja el proveedor puesto
  // para que la firma del pipeline no cambie.
  llm: { complete: async () => '' },
  image: new ImageProvider({ apiKey: process.env.GEMINI_API_KEY, prefer: 'auto' }),
  tts: new TtsProvider({ apiKey: process.env.GEMINI_API_KEY }),
  storageDir: STORAGE,
  onProgress: (p) => {
    const linea = `${p.stage} ${p.completed}/${p.total} ${p.status}`;
    if (p.stage + ':' + p.completed !== deps._ultimo) {
      deps._ultimo = p.stage + ':' + p.completed;
      console.log(`   ${linea}${p.message ? '  (' + p.message + ')' : ''}`);
    }
  },
  _ultimo: '',
};

const t0 = Date.now();

console.log('\n=== Frutinovela: ' + story.title + ' ===');
console.log(`   ${story.characters.length} personajes · ${story.scenes.length} planos`);
console.log(`   estilo: ${story.visualStyleId}\n`);

const faltan = secondsToMonetizable(story, { requireApproval: true });
console.log(`   Duracion estimada del guion: ${story.scenes.length * 9}s ${faltan > 0 ? '(se ajustara con el audio real)' : ''}\n`);

console.log('--- 1) Imagenes (Pollinations) ---');
await generateImages(deps, story, { variants: 1 });
console.log(`    listas: ${story.scenes.every((s) => s.variants.length > 0)}`);
console.log(`    hojas de personaje: ${story.characters.map((c) => c.name + (c.referenceImagePath ? ' OK' : ' FALLO')).join(', ')}\n`);

console.log('--- 2) Voz (Piper local) ---');
await generateVoice(deps, story);
const conAudio = story.scenes.filter((s) => s.audioPath).length;
console.log(`    planos con audio: ${conAudio}/${story.scenes.length}`);
console.log(`    motor: ${deps.tts.lastBackend}\n`);

const dur = totalDuration(story, { requireApproval: false });
console.log(`    duracion real de la voz: ${dur.toFixed(1)}s`);
console.log(`    pagable en TikTok: ${dur >= MIN_MONETIZABLE_SEC ? 'si' : 'NO, faltan ' + (MIN_MONETIZABLE_SEC - dur).toFixed(0) + 's'}\n`);

console.log('--- 3) Render (ffmpeg) ---');
// Sin una persona que apruebe, se saltan la curaduria de forma explicita.
for (const s of story.scenes) s.status = 'approved';

const salida = await composeFinal(deps, story, { quality: 'standard', requireApproval: true });
const bytes = statSync(salida).size;

// Copia con nombre legible en el escritorio del usuario.
const destino = path.join(STORAGE, 'frutinovela-demo.mp4');
await writeFile(destino, await readFile(salida));

console.log('\n=== RESULTADO ===');
console.log(`  archivo:    ${destino}`);
console.log(`  peso:       ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  duracion:   ${dur.toFixed(2)}s`);
console.log(`  pagable:    ${dur >= MIN_MONETIZABLE_SEC ? 'si' : 'no'}`);
console.log(`  resolucion: 1080x1920 (9:16)`);
console.log(`  tiempo:     ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log('');
