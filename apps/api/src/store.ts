/**
 * Persistencia de historias en archivos JSON.
 *
 * Se eligio almacenamiento en archivo en vez de Postgres por una razon concreta:
 * el producto es de un solo escritor y un solo servidor en la v1. Una base de
 * datos anadiria una dependencia que hay que hostear y pagar, sin ganar nada
 * todavia. Cuando haya varios usuarios y despliegue horizontal, esta capa se
 * reemplaza por un repositorio de Postgres sin tocar las rutas.
 */

import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { repairStoryCharacterReferences, type Scene, type Story } from '@frutia/core';

/**
 * Normaliza una historia venida de disco.
 *
 * Los campos de variantes se anadieron despues del primer prototipo, asi que
 * las historias guardadas antes no los tienen. Sin esta normalizacion, una
 * historia antigua reventaria al pedirle una variante y el usuario perderia el
 * trabajo hecho.
 */
function migrate(story: Story): Story {
  // Las historias del prototipo guardaban una unica imagen en `imagePath`,
  // que ya no existe en el tipo. Se lee como `unknown` porque en disco puede
  // estar o no, y es exactamente el caso que esta migracion cubre.
  type LegacyScene = Scene & { imagePath?: string };

  for (const scene of story.scenes as LegacyScene[]) {
    scene.variants ??= [];
    scene.activeVariant ??= 0;
    scene.attempts ??= 0;
    if (scene.variants.length === 0 && scene.imagePath) {
      scene.variants = [scene.imagePath];
      scene.activeVariant = 0;
    }
    delete scene.imagePath;
  }
  return repairStoryCharacterReferences(story);
}

export class StoryStore {
  constructor(private readonly root: string) {}

  private fileFor(storyId: string): string {
    // El id viene del servidor (UUID), pero se filtra igual: un id con
    // separadores de ruta permitiria leer o escribir fuera del directorio.
    if (!/^[a-zA-Z0-9-]+$/.test(storyId)) throw new Error('Id de historia invalido.');
    return path.join(this.root, `${storyId}.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async save(story: Story): Promise<Story> {
    story.updatedAt = new Date().toISOString();
    const file = this.fileFor(story.id);

    // Escritura atomica: se escribe a un temporal y se renombra. Asi una
    // caida a mitad de guardado no deja un JSON truncado que rompa la app.
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(story, null, 2), 'utf8');
    await rename(tmp, file);
    return story;
  }

  async get(storyId: string): Promise<Story | null> {
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(storyId), 'utf8')) as Story;
      return migrate(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(): Promise<Story[]> {
    const files = await readdir(this.root).catch(() => [] as string[]);
    const stories = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map((f) => this.get(path.basename(f, '.json')).catch(() => null)),
    );
    return stories
      .filter((s): s is Story => s !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(storyId: string): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    await unlink(this.fileFor(storyId)).catch(() => undefined);
  }

  /**
   * Aplica cambios parciales a una historia. Centraliza la validacion del
   * estado de los planos para que ninguna ruta pueda saltarse la curaduria.
   */
  async patchScene(storyId: string, sceneId: string, patch: Partial<Scene>): Promise<Story> {
    const story = await this.get(storyId);
    if (!story) throw new NotFoundError(`No existe la historia ${storyId}`);

    const scene = story.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new NotFoundError(`No existe el plano ${sceneId}`);

    if (patch.status && !['draft', 'generated', 'approved', 'rejected'].includes(patch.status)) {
      throw new ValidationError('Estado de plano invalido.');
    }

    if (patch.activeVariant !== undefined) {
      if (
        !Number.isInteger(patch.activeVariant) ||
        patch.activeVariant < 0 ||
        patch.activeVariant >= scene.variants.length
      ) {
        throw new ValidationError('Variante fuera de rango.');
      }
    }

    delete story.videoPath;
    Object.assign(scene, patch);
    return this.save(story);
  }

  /** Aplica una transformacion de estructura y persiste el resultado. */
  async mutate(storyId: string, transform: (story: Story) => void): Promise<Story> {
    const story = await this.get(storyId);
    if (!story) throw new NotFoundError(`No existe la historia ${storyId}`);
    transform(story);
    return this.save(story);
  }
}

export class NotFoundError extends Error {}
export class ValidationError extends Error {}
