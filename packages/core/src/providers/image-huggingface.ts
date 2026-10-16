import { InferenceClient } from '@huggingface/inference';
import type { GenerateImageInput, GenerateImageOptions, GenerateImageOutput } from './image-types.js';

/** Text-to-image through Hugging Face Inference Providers. */
export class HuggingFaceImageProvider implements GenerateImageOptions {
  private readonly client: InferenceClient;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: { token?: string; model?: string; timeoutMs?: number } = {}) {
    const token = opts.token || process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY;
    if (!token) {
      throw new Error('Imagen Hugging Face: falta HF_TOKEN en el .env del servidor.');
    }
    this.client = new InferenceClient(token);
    this.model = opts.model || process.env.FRUTIA_HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell';
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.FRUTIA_HF_TIMEOUT_MS ?? 180_000);
  }

  async generate(input: GenerateImageInput): Promise<GenerateImageOutput> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const image = await this.client.textToImage({
        model: this.model,
        provider: 'auto',
        inputs: input.prompt,
        parameters: {
          seed: input.seed,
          width: input.width,
          height: input.height,
          num_inference_steps: 4,
        },
      }, { outputType: 'blob', signal: controller.signal });
      const bytes = Buffer.from(await image.arrayBuffer());
      if (!bytes.length) throw new Error('Hugging Face devolvió una imagen vacía.');
      return { base64: bytes.toString('base64'), mimeType: image.type || 'image/png' };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Hugging Face tardó más de ${Math.ceil(this.timeoutMs / 1000)} segundos en generar la imagen.`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Hugging Face no pudo generar la imagen: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
