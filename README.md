# 🍓 Frutia — Generador de Frutinovelas con IA

SaaS web para convertir un guion pegado en un minidrama vertical (9:16), con
personajes consistentes, imágenes, voz, subtítulos y vista previa MP4. El usuario
puede elegir idioma, motor de imagen, estilo y otros ajustes antes de generar.

---

## Por qué este diseño

**El riesgo de plataforma.** TikTok endureció su política de originalidad: el
contenido **100% generado por IA queda excluido** del Creator Rewards Program,
y hay descalificaciones masivas por "unoriginal content". Por eso el flujo tiene
puntos de control obligatorios: nada se marca como publicable sin que una
persona lo apruebe. La app no automatiza el *posting*; automatiza el trabajo
pesado de producción.

**El modo $0.** Los modelos de video (Veo, Kling, Seedance, Runway) **no tienen
free tier**. La v1 no genera video con IA: compone una pieza narrativa a partir
de imágenes generadas + movimiento de cámara + voz + subtítulos, que cuesta $0 y
es un formato ya probadamente viral. La capa de animación de video entra por
interfaz (`VideoProvider`) cuando haya ingresos.

**Vite y no Next.js.** La v1 es una herramienta de producción, no una landing
paginada: no hay SEO que sirva aquí todavía. Vite itera mucho más rápido y pesa
menos. La landing de marketing irá en Next.js aparte, más adelante.

---

## Arquitectura

Monorepo con workspaces de npm:

```
frutia/
├── packages/
│   └── core/          # Pipeline + proveedores de IA (TypeScript, sin framework)
│       ├── types.ts               # Modelo de dominio
│       ├── prompts.ts             # Arcos, arquetipos y estilos de frutinovela
│       ├── pipeline.ts            # Orquestación por etapas
│       ├── providers/
│       │   ├── llm.ts             # Guion + hoja de personaje
│       │   ├── image.ts           # Enrutamiento entre motores de imagen
│       │   ├── image-huggingface.ts # Hugging Face Inference Providers
│       │   └── tts.ts             # Voz en español
│       └── render/
│           ├── ffmpeg.ts          # Composición 9:16 + Ken Burns
│           └── subtitles.ts       # ASS palabra-por-palabra estilo TikTok
├── apps/
│   ├── api/           # Express: endpoints + cola de trabajos
│   └── web/           # Vite + React: interfaz de curaduría
├── storage/           # Artefactos generados (gitignored)
└── PLAN.md            # Roadmap y modelo de monetización
```

**Dependencias:** Node 20+, TypeScript, Express, Zod, Vite, React,
`ffmpeg-static`. Sin Docker, sin Redis, sin base de datos en la v1.

### Decisiones de diseño relevantes

- **Cola en memoria, no BullMQ.** Con un solo worker, una cola en proceso con
  límite de concurrencia hace lo mismo y cuesta cero. `apps/api/src/jobs.ts` es
  la única pieza a sustituir cuando haya que escalar.
- **JSON en disco, no Postgres.** Un solo escritor, un solo servidor. La capa
  `StoryStore` se reemplaza por un repositorio sin tocar las rutas.
- **Consistencia de personaje por referencia.** Se genera una ficha por
  personaje y se reinyecta en cada plano donde aparece. Es lo que hace que una
  historia con arco tenga continuidad visual.
- **Estilo visual persistido con su id.** Permite regenerar una toma concreta
  manteniendo el mismo lenguaje gráfico.

---

## Pipeline

```
Guion pegado (o una idea)
 └─▶ Adaptación a escenas (LLM) · gancho → conflicto → cliffhanger
     ├─▶ Fichas de personajes · 3–5 diseños visuales consistentes
     ├─▶ Imágenes · referencias de personaje reinyectadas por plano
     ├─▶ Voz en el idioma elegido y subtítulos palabra por palabra
     └─▶ Vista previa MP4 automática, o revisión antes del render
```

El flujo principal empieza pegando un guion de hasta 16.000 caracteres. Frutia
lo divide en escenas y prepara el reparto, las imágenes, las voces y los
subtítulos. Por defecto también renderiza una vista previa local. Se puede
desactivar el render automático y hacerlo después de revisar los planos. La app
nunca publica en redes; para la exportación final en producción se requiere
aprobación de los planos (`NODE_ENV=production`).

### Trabajo por plano

Rehacer una historia entera vuelve a crear cada escena. Regenerar **un solo plano**
repite solo esa imagen, y es la operación que más se repite: una toma queda mal y
se vuelve a generar sin tocar lo demás. El plano vuelve a estado `generated` y pierde la
aprobación anterior, porque si la imagen cambió la aprobación ya no significa
nada.

Las **variantes** generan varias candidatas de una sentada y dejan elegir a ojo.
Duplicar un plano copia imagen y audio sin llamar a ninguna IA; reordenar recalcula
los índices, porque de ellos dependen los subtítulos.

### Sorpréndeme

El botón **Sorpréndeme** genera cinco premisas que no se han contado antes,
combinando 14 protagonistas × 12 antagonistas × 12 conflictos × 14 lugares ×
7 giros × 6 enfoques = **1.185.408 combinaciones** (unos 1.600 años publicando dos
veces al día).

No repetir es la mitad de la función. Un canal que cuenta la misma premisa tres
veces pierde a su audiencia aunque cambien los personajes. Al elegir una propuesta
se guarda su índice y deja de ofrecerse; el historial vive en
`storage/ideas-usadas.json`.

### Perfiles de generación

La instalación predeterminada usa motores locales y evita llamadas ocultas o
compras de créditos:

| Etapa | Motor predeterminado | Alternativa |
|---|---|---|
| Guion y escenas | Ollama `qwen2.5:3b` | Google Gemini con clave configurada |
| Imágenes | ComfyUI y Stable Diffusion 1.5 | Hugging Face o Google/Pollinations al cambiar el proveedor |
| Voces | Piper | Voces en la nube si se cambia el proveedor |
| Montaje, subtítulos y MP4 | FFmpeg local | — |

En Opciones de producción se puede seleccionar Hugging Face
`black-forest-labs/FLUX.1-schnell`. Necesita `HF_TOKEN` y puede consumir
créditos. ComfyUI en CPU tarda más que una GPU; el pipeline evita crear retratos
de referencia que ese workflow local no puede usar.

---

## Puesta en marcha

Requisitos: Node 20 o superior.

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar
cp .env.example .env      # en Windows: copy .env.example .env
```

El `.env.example` configura el modo local: Ollama (`qwen2.5:3b`), ComfyUI
(checkpoint Stable Diffusion 1.5) y Piper. Para usarlo, instala o abre esos
tres motores en la máquina. Si se ejecutan solo con CPU, la generación de
imágenes puede tardar varios minutos.

Para usar motores remotos, cambia los proveedores en `.env` y configura las
claves correspondientes. Google AI Studio puede dar cuota gratuita; Hugging
Face y Pollinations pueden consumir créditos o saldo. Frutia no contrata
servicios ni publica el resultado automáticamente.

Si quieres usar Pollinations como respaldo, añade una clave secreta en
`POLLINATIONS_API_KEY`. Sus imágenes consumen saldo Pollen; Frutia ya no
reintenta respuestas 402 porque no se resuelven esperando.

Para seleccionar Hugging Face en las opciones, crea un token con permiso
**Make calls to Inference Providers** y guárdalo en `.env` como `HF_TOKEN`.
La inferencia puede requerir créditos o pago según la cuenta/modelo; consulta
el [precio y consumo](https://huggingface.co/docs/inference-providers/pricing).

```bash
# 3. Compilar el núcleo
npm run build --workspace=@frutia/core

# 4. Probar
npm test          # 39 pruebas del núcleo, incluido el render real con ffmpeg
npm run test:api  # 25 comprobaciones del contrato HTTP (levanta el servidor)

# 5. Levantar API (http://localhost:4000) y web (http://localhost:5173)
npm run dev
```

Abre <http://localhost:5173>, ve a **Nueva**, pega un guion y genera tu
frutinovela. Frutia crea las escenas, las voces, los subtítulos y, por defecto,
el MP4. En el editor puedes subir imágenes propias y una pista musical local.

Sin clave puedes ver el pipeline entero funcionando con contenido sintético:

```bash
npm run demo      # renderiza un MP4 real usando imagenes y audio generados con ffmpeg
```

### Estructura de la salida

```
storage/<storyId>/
├── ref-c1.png …        # fichas de personaje
├── scenes/s1.png …     # imagen de cada plano
├── audio/s1.mp3 …      # voz de cada plano
├── subtitles.ass       # subtítulos con resaltado por palabra
└── <storyId>.mp4       # video final
```

---

## Curva de coste

| Etapa | Coste |
|---|---|
| Guion | Free tier de Gemini Flash |
| Imágenes | Free tier de `gemini-3.1-flash-image` (~100–500/día) |
| Voz | Free tier de `gemini-3.1-flash-tts-preview` (~100k caracteres/mes) |
| Render | ffmpeg local, `$0` |

El free tier es el techo de esta fase. En cuanto escales, el pipeline añade un
proveedor de video real (Veo Lite a $0.05/s). Ver `PLAN.md` para los números de
coste por video y el modelo de precios.

---

## Estado

Fase 1 (MVP) completa a falta de **conectar la clave y generar un video real**.
Ver `PLAN.md` para las fases 2 a 5 y el modelo de monetización.
