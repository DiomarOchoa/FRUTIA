# Frutia

Generador de frutinovelas con IA para TikTok, Reels y Shorts.

---

## Cómo iniciar

**Doble clic en `iniciar.cmd`.**

Eso es todo. Se abre el navegador solo con la app en
<http://localhost:5173>.

> **Deja la ventana negra abierta** mientras uses la app. Si la cierras, el
> servidor se apaga y la página deja de funcionar. Cuando termines, ciérrala.

La primera vez instala las dependencias y puede tardar unos minutos.

---

## Si no tienes clave de API

La app se abre igual, pero **no genera videos**. Para conseguirla gratis:

1. Entra en <https://aistudio.google.com/apikey>
2. Inicia sesión con Google → **Create API key**
3. Copia la clave (empieza por `AIza`)
4. Abre el Bloc de notas y escribe:

   ```
   GEMINI_API_KEY=pega_aqui_la_clave
   ```

5. Guárdalo en esta carpeta como `.env` (tipo "Todos los archivos", sin `.txt`)

> ⚠️ **No lo guardes con PowerShell** (`Set-Content`), porque añade unos
> caracteres que rompen la clave en silencio. Con el Bloc de notas estás a salvo.

Para comprobar que todo funciona:

```bash
node scripts/check-todo.mjs
```

---

## Qué hace

Escribes un tema → la IA escribe el guion, genera las imágenes, sintetiza la
voz en español y compone un video vertical de 60+ segundos con subtítulos
resaltados palabra a palabra. Tú revisas y apruebas cada plano antes de
exportar.

Los detalles técnicos están en `README.md` y el plan de negocio en `PLAN.md`.

---

## Problemas frecuentes

| Síntoma | Causa |
|---|---|
| La página no carga | Cerraste la ventana de `iniciar.cmd` |
| "Conexión rechazada" | El servidor no está corriendo: vuelve a hacer doble clic |
| "Falta GEMINI_API_KEY" | El archivo `.env` no existe o está guardado como `.env.txt` |
| Video de 3 minutos en vez de 1 | No debería pasar; si ocurre, reporta el error |
| Error 429 al generar imágenes | Google agotó la cuota; el sistema cae solo a Pollinations |