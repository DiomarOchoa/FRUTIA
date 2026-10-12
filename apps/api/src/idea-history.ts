/**
 * Historial de ideas ya usadas.
 *
 * Se guarda aparte de las historias porque responde a una pregunta distinta:
 * no es "que historias hay", sino "que premises se han contado ya". Una
 * premise puede haberse usado con guiones diferentes y aun asi cuenta como
 * como repetida, porque a la audiencia le va a sonar igual.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface UsedIdea {
  index: number;
  topic: string;
  title: string;
  /** Marca de tiempo, para poder limpiar el historial. */
  at: string;
  /** Id de la historia resultante, si llego a generarse. */
  storyId?: string;
}

export class IdeaHistory {
  private cache: UsedIdea[] | null = null;

  constructor(private readonly file: string, private readonly limit = 500) {}

  private async load(): Promise<UsedIdea[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch {
      // Primer arranque, o historial corrupto: se empieza de cero en vez de
      // romper el boton de ideas.
      this.cache = [];
    }
    return this.cache;
  }

  private async persist(items: UsedIdea[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    // Se conserva solo lo reciente: el limite evita que el archivo crezca sin
    // fin y las combinaciones son tantas que no hace falta mas memoria.
    const trimmed = items.slice(-this.limit);
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(trimmed, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.file);
    this.cache = trimmed;
  }

  async all(): Promise<UsedIdea[]> {
    return this.load();
  }

  async usedIndexes(): Promise<number[]> {
    return (await this.load()).map((i) => i.index);
  }

  async add(entry: UsedIdea): Promise<void> {
    const items = await this.load();
    // Una idea no se registra dos veces aunque se pulse dos veces.
    if (items.some((i) => i.index === entry.index)) return;
    await this.persist([...items, entry]);
  }

  async clear(): Promise<void> {
    await this.persist([]);
  }

  get size(): number {
    return this.cache?.length ?? 0;
  }
}