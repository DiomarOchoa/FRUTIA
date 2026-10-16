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

## Motores de IA

Esta instalación está configurada para producir en local, sin claves ni saldo:
Ollama (`qwen2.5:3b`) escribe el guion; ComfyUI crea las imágenes; Piper genera
las voces; FFmpeg arma el MP4. Los tres servicios locales deben estar abiertos.
En este equipo ComfyUI trabaja con CPU, por lo que cada imagen puede tardar más.

Si prefieres servicios en la nube, consulta `.env.example`: Google y Hugging
Face necesitan sus propias claves; Pollinations puede consumir saldo. Frutia
no compra créditos ni publica videos por su cuenta.

---

## Qué hace

Pegas un guion → la IA lo adapta al idioma elegido, genera las imágenes,
sintetiza la voz y compone un video vertical de 60+ segundos con subtítulos
resaltados palabra a palabra. Tú revisas y apruebas cada plano antes de
exportar.

En **Opciones de producción** puedes elegir Hugging Face para las imágenes.
Para activarlo, agrega un token HF con permiso de Inference Providers al `.env`
del servidor como `HF_TOKEN`; ese servicio puede consumir créditos.

En el editor puedes reemplazar cualquier imagen con PNG, JPG o WebP, subir una
pista musical y previsualizarla. Al exportar, Frutia mezcla la música bajo las
voces. El archivo queda asociado a la historia local.

Los detalles técnicos están en `README.md` y el plan de negocio en `PLAN.md`.

---

## Problemas frecuentes

| Síntoma | Causa |
|---|---|
| La página no carga | Cerraste la ventana de `iniciar.cmd` |
| "Conexión rechazada" | El servidor no está corriendo: vuelve a hacer doble clic |
| No genera texto | Comprueba que Ollama esté abierto y que `qwen2.5:3b` esté instalado |
| No genera imágenes | Comprueba ComfyUI en `http://127.0.0.1:8188` y el checkpoint configurado |
| No genera voces | Comprueba Piper, `PIPER_BIN` y el modelo `.onnx` en `.env` |
| Video de 3 minutos en vez de 1 | No debería pasar; si ocurre, reporta el error |
| Error 402 de Pollinations | Revisa su clave y saldo Pollen; Frutia no repetirá llamadas que requieren saldo |
| Error de ComfyUI | Revisa que el checkpoint de Stable Diffusion 1.5 esté instalado y disponible |
| Falta `HF_TOKEN` | Seleccionaste Hugging Face sin configurar su token en `.env` |
