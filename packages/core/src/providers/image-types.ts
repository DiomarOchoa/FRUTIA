/**
 * Contrato compartido por los proveedores de imagen.
 *
 * Lo separo del proveedor de Gemini para que la alternativa de Pollinations
 * pueda implementarlo sin importar el cliente de Google.
 */

export interface GenerateImageInput {
  prompt: string;
  /** Imagenes de referencia en base64, para continuidad de personaje. */
  referenceImages?: { base64: string; mimeType: string }[];
  /**
   * Semilla. Misma semilla y mismo prompt producen la misma imagen, lo que
   * hace que una variante sea recuperable en vez de un resultado efimero.
   */
  seed?: number;
  /** Ancho solicitado. Lo ignoran los proveedores que fijan su resolucion. */
  width?: number;
  /** Alto solicitado. */
  height?: number;
}

export interface GenerateImageOutput {
  base64: string;
  mimeType: string;
}

/** Cualquier proveedor de imagen debe cumplir esta forma. */
export interface GenerateImageOptions {
  generate(input: GenerateImageInput): Promise<GenerateImageOutput>;
}