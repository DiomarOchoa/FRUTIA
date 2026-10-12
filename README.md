# 🍓 Frutia — Generador de Frutinovelas con IA

SaaS web para generar minidramas narrativos verticales (9:16) listos para TikTok,
Reels y Shorts, con personajes consistentes, voz en español y subtítulos
estilizados. Flujo **semi-automático con curaduría humana**.

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
│       │   ├── image.ts           # Imágenes de personaje y planos
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
Tema
 └─▶ Guion (LLM)              arco de 8 planos: hook → … → cliffhanger
     └─▶ Hoja de personaje     3-5 personajes con descripción visual fija
         └─▶ Imagen por plano  reinyectando la ficha del personaje
             └─▶ Voz (TTS ES)  un clip de audio por plano
                 └─▶ Subtítulos alineados, resaltado palabra a palabra
                     └─▶ Render — Ken Burns + concat + quemado de subtítulos
                         └─▶ EXPORTAR 1080x1920
```

El pipeline **se detiene antes de componer**. El usuario revisa y aprueba cada
plano; solo entonces se renderiza. En producción, el servidor fuerza esa barrera
(`NODE_ENV=production`).

### Trabajo por plano

Rehacer una historia entera cuesta unas 13 llamadas. Regenerar **un solo plano**
cuesta una, y es la operación que más se repite: una toma queda mal y se vuelve a
tirar solo esa imagen. El plano vuelve a estado `generated` y pierde la
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

### Proveedores con cascada

Cada motor intenta Google primero y cae a Pollinations si la cuota se agota:

| Motor | Principal | Respaldo |
|---|---|---|
| Guion | `gemini-3.8-flash` | — (sin alternativa gratuita igual de buena) |
| Imagen | `gemini-3.1-flash-image` | Pollinations `flux` |
| Voz | `gemini-3.1-flash-tts-preview` | Pollinations |

Los nombres de modelo **no están fijos en el código**: hay una lista de
candidatos y, si uno devuelve 404 por retirada, se prueba el siguiente. Google
retiró `gemini-2.5-flash` para cuentas nuevas a mitad de 2026 y habría tumbado el
proyecto entero si el nombre hubiera estado escrito a fuego.

---

## Puesta en marcha

Requisitos: Node 20 o superior.

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar
cp .env.example .env      # en Windows: copy .env.example .env
```

Edita `.env` y pega tu clave de **Google AI Studio** (gratis):
https://aistudio.google.com/apikey

```bash
# 3. Compilar el núcleo
npm run build --workspace=@frutia/core

# 4. Probar
npm test          # 39 pruebas del núcleo, incluido el render real con ffmpeg
npm run test:api  # 25 comprobaciones del contrato HTTP (levanta el servidor)

# 5. Levantar API (http://localhost:4000) y web (http://localhost:5173)
npm run dev
```

Abre <http://localhost:5173>, ve a **Nueva**, escribe un tema y genera tu
primera frutinovela. Tarda 3–8 minutos: son 4 a 60 llamadas a la API según
cuántas variantes pidas por plano.

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
| Imágenes | Free tier de `gemini-2.5-flash-image` (~100–500/día) |
| Voz | Free tier de `gemini-2.5-flash-preview-tts` (~100k caracteres/mes) |
| Render | ffmpeg local, `$0` |

El free tier es el techo de esta fase. En cuanto seANCES, el pipeline añade un
proveedor de video real (Veo Lite a $0.05/s). Ver `PLAN.md` para los números de
coste por video y el modelo de precios.

---

## Estado

Fase 1 (MVP) completa a falta de **conectar la clave y generar un video real**.
Ver `PLAN.md` para las fases 2 a 5 y el modelo de monetización.