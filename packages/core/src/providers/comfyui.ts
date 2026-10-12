import { randomUUID } from 'node:crypto';
import type { GenerateImageInput, GenerateImageOptions, GenerateImageOutput } from './image-types.js';

type ComfyImage = { filename: string; subfolder: string; type: string };
type ComfyEntry = { status?: { completed?: boolean }; outputs?: Record<string, { images?: ComfyImage[] }> };
type ComfyHistory = Record<string, ComfyEntry>;

/** Generador local mediante la API HTTP de ComfyUI. */
export class ComfyUiImageProvider implements GenerateImageOptions {
  private readonly baseUrl = (process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188').replace(/\/+$/, '');
  private readonly checkpoint = process.env.FRUTIA_COMFYUI_CHECKPOINT ?? 'v1-5-pruned-emaonly.safetensors';
  private readonly timeoutMs = Number(process.env.FRUTIA_COMFYUI_TIMEOUT_MS ?? 600_000);
  private readonly steps = Math.max(1, Math.min(30, Number(process.env.FRUTIA_COMFYUI_STEPS ?? 6)));

  async generate(input: GenerateImageInput): Promise<GenerateImageOutput> {
    const promptId = await this.enqueue(input);
    const started = Date.now();
    while (Date.now() - started < this.timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const response = await fetch(this.baseUrl + '/history/' + encodeURIComponent(promptId));
      if (!response.ok) throw new Error('ComfyUI history ' + response.status + ': ' + (await response.text()).slice(0, 300));
      const history = await response.json() as ComfyHistory;
      const entry = history[promptId];
      const image = Object.values(entry?.outputs ?? {}).flatMap((output) => output.images ?? [])[0];
      if (!image && entry?.status?.completed) throw new Error('ComfyUI termino el trabajo sin producir una imagen. Revisa el checkpoint configurado.');
      if (!image) continue;
      const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
      const result = await fetch(this.baseUrl + '/view?' + query.toString());
      if (!result.ok) throw new Error('ComfyUI no pudo devolver la imagen: HTTP ' + result.status);
      const bytes = Buffer.from(await result.arrayBuffer());
      if (!bytes.length) throw new Error('ComfyUI devolvio una imagen vacia.');
      const mimeType = result.headers.get('content-type')?.split(';')[0] || 'image/png';
      return { base64: bytes.toString('base64'), mimeType };
    }
    throw new Error('ComfyUI no termino la imagen en ' + Math.round(this.timeoutMs / 1000) + ' segundos.');
  }

  private async enqueue(input: GenerateImageInput): Promise<string> {
    const seed = input.seed ?? Math.floor(Math.random() * 2_147_483_647);
    const workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: this.checkpoint } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: input.prompt, clip: ['1', 1] } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, deformed, extra limbs, text, watermark', clip: ['1', 1] } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: input.width ?? 512, height: input.height ?? 896, batch_size: 1 } },
      '5': { class_type: 'KSampler', inputs: { seed, steps: this.steps, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
      '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'frutia', images: ['6', 0] } },
    };
    const response = await fetch(this.baseUrl + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('ComfyUI rechazo el flujo (' + response.status + '): ' + detail.slice(0, 500));
    }
    const result = await response.json() as { prompt_id?: string };
    if (!result.prompt_id) throw new Error('ComfyUI no devolvio un identificador de trabajo.');
    return result.prompt_id;
  }
}
