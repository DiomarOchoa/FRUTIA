# PLAN — Frutia

Roadmap de producto y monetización. Decisiones ya tomadas, con el porqué.

---

## 0. Decisiones tomadas

| Decisión | Valor | Motivo |
|---|---|---|
| Modelo | SaaS web de suscripción | Ingreso recurrente, control del pipeline, escala |
| Plataformas | Web primero, móvil después | Se itera 10x más rápido en navegador |
| Presupuesto inicial | $0 | Solo free tiers; sin video generativo |
| Curaduría | Obligatoria por plano | Protege contra la descalificación de TikTok |
| Pipeline | Stills + movimiento + voz + subtítulos | Los modelos de video no tienen free tier |

---

## 1. Por qué la curaduría no es opcional

Este es el hallazgo más importante de la investigación y condiciona todo lo demás.

- El **Creator Rewards Program** exige 10K seguidores, 100K views/30d, cuenta
  **Personal** y videos **originales de más de 60s**.
- TikTok endureció su política de originalidad: el contenido **100% generado por
  IA queda excluido** de los programas de monetización. Solo pasan los flujos
  asistidos (color, subtítulos, B-roll, voz).
- Hay reportes de descalificaciones masivas por "unoriginal content" incluso
  sobre material propio. El programa reparte 50/50 con el anunciante: cada video
  descalificado es dinero que TikTok se queda.

**Consecuencia de diseño:** el pipeline nunca marca un plano como publicable.
`SceneStatus` transita a `approved` solo por acción humana, y en producción
`requireApproval` está forzado a `true` en el servidor. Automatizar el *posting*
queda fuera del alcance: la app produce, la persona publica.

---

## 2. Unit economics (lo que define el precio)

Costos reales de una frutinovela de 60s en el modo $0:

| Costo | Cantidad | Observación |
|---|---|---|
| Guion | 1 llamada Gemini Flash | ~$0 (free tier) |
| Imágenes | 3–5 fichas + 8 planos | $0 con cascada a Pollinations |
| Voz | 8 clips de audio | free tier, ~100k caracteres/mes |
| Render | ffmpeg local | $0 |

### La cuota de imágenes es el punto frágil

El free tier de Google para imagenes (`gemini-*-image`) puede responder `429`
con **cuota cero** aunque la clave sea válida, según el estado de la cuenta. Es
lo que ocurrió al probar el proyecto, y contradice lo que se documenta como
"~500 imágenes/día".

Por eso `ImageProvider` es ahora una **cascada**: intenta Google y, solo si el
fallo es de cuota, cae a **Pollinations.ai** (Flux, sin clave ni tarjeta,
verificado a ~2,9s por imagen). Configurable con `FRUTIA_IMAGE_PROVIDER`:

| Valor | Comportamiento |
|---|---|
| `auto` *(por defecto)* | Google primero, Pollinations si la cuota se agota |
| `gemini` | Solo Google; falla si no hay cuota |
| `pollinations` | Solo el gratuito |

**Limitación honesta de la degradación:** Pollinations no acepta imágenes de
referencia, así que la consistencia de personaje se apoya únicamente en la
descripción textual del prompt. Es peor que la ficha de referencia, pero
mantiene el flujo funcionando sin gastar un peso.

Cuando se añada video generativo (tras los primeros ingresos):

| Modelo | $/seg | Costo de un video de 60s |
|---|---|---|
| Veo 3.1 Lite | $0.05 | $3.00 |
| Seedance 2.0 | $0.09 | $5.40 |
| Runway Gen-4.5 | $0.12 | $7.20 |
| Veo 3.1 Standard (con audio) | $0.40 | $24.00 |

**Y hay que multiplicar por 3**: en la práctica se generan varios takes por
plano y se conserva uno. **Costo realista: $9–24 por video.**

Esto fija el precio: vender a menos de $5 un video generado con video real es
margen negativo. El modelo correcto es **créditos prepagados con margen de
recargo del 60-100%**, no planes ilimitados.

---

## 3. Monetización

### 3.1 Fuentes de ingreso, en orden de prioridad

| # | Vía | Cuándo | Potencial |
|---|---|---|---|
| 1 | **Suscripción SaaS** | Desde el día 1 (web) | Recurrente, escala |
| 2 | **Créditos extra / packs** | Al validar calidad | Recurrente, margen alto |
| 3 | **Afiliación en los canales** | 1K seguidores | Complementa pronto |
| 4 | **Brand deals / UGC** | 10K+ en nicho | Ticket medio alto |
| 5 | **Plantillas y packs de prompts** | Con audience | Ingreso pasivo |
| 6 | **YouTube Shorts / Reels** | Inmediato | RPM más alto, IA permitida con disclosure |
| 7 | **Creator Rewards** | 10K+ **y contenido no 100% IA** | No contar con esto |

El punto 7 está deliberadamente al final: no es una base de ingresos fiable.

### 3.2 Pricing inicial propuesto

RevenueCat 2026: un **hard paywall** convierte 5x mejor que freemium
(10.7% vs 2.1% D35). Y la tasa de baja mensual del App Store es del 82.9%.
El modelo tiene que ser de baja fricción, no mensual.

```
Gratis        — 3 videos/mes, marca de agua, 720p
Pro           — $12/mes, 30 videos, sin marca de agua, 1080p
Studio        — $29/mes, 90 videos + personajes guardados + API
Créditos      — packs de 10 videos a $9 (margen si el costo es $3-9)
```

Los números se ajustan con datos reales de conversión, no antes.

### 3.3 Palanca del propio producto

Frutia se usa a sí mismo: sus propios canales de frutinovelas son el caso de uso,
el banco de pruebas y el canal de adquisición. Si el contenido que la app produce
viraliza, los usuarios ya vieron el resultado antes de pagar.

---

## 4. Hoja de ruta

### Fase 1 — MVP (semanas 1–3) · estado: completa
- [x] Modelo de dominio y pipeline (`@frutia/core`)
- [x] Prompts de frutinovela: arcos, arquetipos, estilos visuales
- [x] Proveedores Gemini: guion, imagen, voz (free tier)
- [x] Subtítulos ASS palabra-a-palabra estilo TikTok
- [x] Composición 9:16 con Ken Burns y transiciones
- [x] Cola de trabajos en memoria con límite de concurrencia
- [x] API REST + interfaz de curaduría
- [x] **Conectar `GEMINI_API_KEY` y generar la primera frutinovela real**
- [ ] Validar que un video generado supera 60s y retiene

### Verificación de la Fase 1

- 39 pruebas unitarias y de integración, todas en verde
- 25 comprobaciones del contrato HTTP contra el servidor real
- Typecheck limpio en core, API y web con `strict` y `noUncheckedIndexedAccess`
- MP4 verificado: 21.23s, 1080x1920, h264, aac, 30fps

### Fase 2 — Calidad (mes 2) · estado: completa
- [x] Regeneración de un plano individual sin rehacer la historia
- [x] Reordenar planos (con reindexado y validación estricta)
- [x] Duplicar plano (copia imagen y audio, sin coste de API)
- [x] Variantes: varias candidatas por plano, elegir a ojo
- [x] Semilla de imagen reproducible
- [x] Migración de historias del formato antiguo (`imagePath` → `variants`)
- [x] **Generador de ideas aleatorias sin repetición** (1.185.408 combinaciones)
- [x] Cascada de proveedores en guion, imagen y voz
- [ ] Biblioteca de personajes persistentes (reutilizar el elenco entre historias)
- [ ] Variantes de voz por personaje
- [ ] Plantillas de formato (episodios, series, cliffhangers enlazados)

### Fase 3 — Monetización (mes 3)
- [ ] Cuentas de usuario y autenticación
- [ ] Stripe + hard paywall + planes
- [ ] Sistema de créditos con consumo medido por video
- [ ] Marca de agua en el plan gratuito
- [ ] Límites de uso por plan (firma anti-abuso)

### Fase 4 — Escala (mes 4+)
- [ ] Proveedor de video real (Veo Lite) tras el toggle `videoProvider`
- [ ] Móvil con Expo reutilizando la API (no el pipeline)
- [ ] Multi-idioma (la demanda más fuerte está fuera de Latinoamérica)
- [ ] Analytics de retención: qué planos funcionan y cuáles se descartan
- [ ] Publicación asistida (guardar en borradores, nunca auto-publicar)

### Fase 5 — Opcional, si la API de TikTok se aprueba
- [ ] Content Posting API en modo `SELF_ONLY` / borradores
- Requisito: pasar la auditoría de TikTok, que exige mostrar en la UI los
  controles de privacidad, duet/stitch y el aviso de contenido generado por IA.

---

## 5. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| TikTok hunde el nicho frutinovelas | Alto | Formato ya visto en 4 plataformas; pivote a otro nicho narrativo |
| Descalificación por "no original" | Alto | Curaduría obligatoria + etiquetado de IA visible |
| Cuota del free tier insuficiente | Medio | Cola con concurrencia 2; avisar al usuario del límite |
| Quality cae al arquetipo "video con IA" | Medio | Planilla de ROI por variante antes de migrar |
| Coste por video supera el precio | Alto | Créditos prepagados con recargo; nunca planes ilimitados |

---

## 6. Decisiones pendientes

1. **Nombre y dominio** — "Frutia" es provisional.
2. **Página de aterrizaje** — Next.js en un subdominio, separado de la app.
3. **Proveedor de video** cuando haya ingresos: Veo Lite vs Seedance vs Kling.
4. **Mercado inicial**: Latinoamérica primero (`es-419`) o inglés desde el día 1.