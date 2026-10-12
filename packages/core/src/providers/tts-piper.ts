/**
 * Motor de voz local: Piper TTS.
 *
 * Es el ultimo de la cascada y el que garantiza que la app siempre tenga voz.
 * Los otros dos dependen de servicios externos con cuota de pago:
 *
 *   1. Google      -> 429 cuando se agota el free tier
 *   2. Pollinations -> 402 sin saldo de Pollen
 *   3. Edge        -> 403, Microsoft lo bloquea fuera del navegador
 *   4. Piper       -> local, gratis, sin limite
 *
 * Se ejecuta en el equipo del usuario mediante el ejecutable de piper. No
 * necesita internet ni clave, asi que un video se puede generar con la red
 * caida, siempre que las imagenes ya esten descargadas.
 *
 * LIMITACION HONESTA
 *
 * Suena mas sintetico que las voces neuronales de Google o Edge. Para un
 * TikTok de fruititwits es aceptable, pero conviene saber que la calidad de voz
 * sube en cuanto vuelve la cuota de Google.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PiperOptions {
  /** Ruta al modelo .onnx. */
  modelPath?: string;
  /** Ruta al ejecutable piper. Si falta, se busca en el PATH. */
  binaryPath?: string;
  timeoutMs?: number;
  /** Longitud maxima por fragmento, en caracteres. */
  chunkSize?: number;
}

export class PiperTtsProvider {
  private readonly modelPath: string;
  private readonly binaryPath: string | undefined;
  private readonly timeoutMs: number;
  private readonly chunkSize: number;

  constructor(opts: PiperOptions = {}) {
    this.modelPath = opts.modelPath
      ?? process.env.PIPER_MODEL
      ?? path.resolve('voces/es_MX-claude-high.onnx');
    this.binaryPath = opts.binaryPath ?? process.env.PIPER_BIN;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    // Piper degrada con textos muy largos: se parte en fragmentos y se une.
    this.chunkSize = opts.chunkSize ?? 400;
  }

  /** El modelo solo se comprueba al construir; aqui se valida al usar. */
  get available(): boolean {
    return existsSync(this.modelPath);
  }

  async speak(text: string): Promise<{ base64: string; mimeType: string }> {
    if (!existsSync(this.modelPath)) {
      throw new Error(`Piper: no existe el modelo en ${this.modelPath}`);
    }
    if (!text.trim()) throw new Error('Piper: texto vacio.');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'frutia-piper-'));
    const out = path.join(dir, 'voz.wav');

    try {
      for (const [i, chunk] of this.dividir(text).entries()) {
        await this.ejecutar(chunk, i === 0 ? out : path.join(dir, `parte-${i}.wav`));
      }

      const partes = this.dividir(text).length;
      const final = partes === 1 ? out : await this.unir(dir, partes);

      const audio = await readFile(final);
      if (audio.length === 0) throw new Error('Piper devolvio audio vacio.');

      return { base64: audio.toString('base64'), mimeType: 'audio/wav' };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Parte el texto en trozos que conservan la puntuacion natural. */
  private dividir(text: string): string[] {
    if (text.length <= this.chunkSize) return [text];

    const partes: string[] = [];
    let resto = text.trim();

    while (resto.length > this.chunkSize) {
      // Se corta en la ultima frase completa antes del limite: partir a
      // mitad de palabra suena a error de lectura.
      const trozo = resto.slice(0, this.chunkSize);
      const corte = Math.max(
        trozo.lastIndexOf('. '), trozo.lastIndexOf(', '), trozo.lastIndexOf('? '), trozo.lastIndexOf('! '),
      );
      const punto = corte > this.chunkSize * 0.4 ? corte + 1 : this.chunkSize;
      partes.push(resto.slice(0, punto).trim());
      resto = resto.slice(punto).trim();
    }

    if (resto) partes.push(resto);
    return partes.filter(Boolean);
  }

  private ejecutar(texto: string, salida: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['--model', this.modelPath, '--output_file', salida, '--', texto];
      const proc = this.binaryPath
        ? spawn(this.binaryPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
        : spawn('piper', args, { stdio: ['ignore', 'ignore', 'pipe'], shell: true });

      let stderr = '';
      proc.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('Piper: la sintesis tardo demasiado.'));
      }, this.timeoutMs);

      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Piper no se pudo ejecutar: ${error.message}`));
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Piper termino con codigo ${code}: ${stderr.slice(-300)}`));
      });
    });
  }

  /** Une los fragmentos WAV usando ffmpeg. */
  private async unir(dir: string, partes: number): Promise<string> {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const ffmpeg = require('ffmpeg-static') as string;
    const salida = path.join(dir, 'completo.wav');

    const archivos = [path.join(dir, 'voz.wav')];
    for (let i = 1; i < partes; i++) archivos.push(path.join(dir, `parte-${i}.wav`));

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, [
        '-y',
        '-i', archivos[0]!,
        ...archivos.slice(1).flatMap((f) => ['-i', f]),
        '-filter_complex', `${archivos.map((_, i) => `[${i}:a]`).join('')}concat=n=${archivos.length}:v=0:a=1[a]`,
        '-map', '[a]',
        salida,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', (c: Buffer) => {
        stderr += c.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg fallo al unir: ${stderr.slice(-300)}`))));
    });

    await mkdir(path.dirname(salida), { recursive: true });
    return salida;
  }
}