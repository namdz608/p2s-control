import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../errors/app-error.mjs';
import { atomicWrite } from '../utils/atomic-file.mjs';

export class ProjectModel {
  static async open(directory) {
    const folder = path.join(directory, 'projects');
    const uploads = path.join(directory, 'uploads');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await mkdir(uploads, { recursive: true, mode: 0o700 });
    // A restart may leave incomplete upload files behind.
    for (const item of await readdir(uploads)) await rm(path.join(uploads, item), { force: true });
    return new ProjectModel(folder);
  }

  constructor(folder) {
    this.folder = folder;
    this.operations = new Map();
  }

  file(id, extension) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new AppError('Không tìm thấy tệp.', 404);
    return path.join(this.folder, `${id}.${extension}`);
  }

  async list() {
    const items = [];
    for (const file of await readdir(this.folder)) {
      if (/^[a-f0-9]{32}\.json$/.test(file))
        items.push(JSON.parse(await readFile(path.join(this.folder, file), 'utf8')));
    }
    return items.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  async get(id) {
    try {
      return JSON.parse(await readFile(this.file(id, 'json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new AppError('Không tìm thấy tệp.', 404);
      throw error;
    }
  }

  async add(file, details) {
    const id = randomBytes(16).toString('hex');
    const name = path
      .basename(file.originalname)
      .replace(/\.gcode\.3mf$/i, '')
      .replace(/[\u0000-\u001f]/g, '')
      .slice(0, 120);
    const project = {
      id,
      name,
      size: (await stat(file.path)).size,
      addedAt: new Date().toISOString(),
      ...details,
    };
    await rename(file.path, this.file(id, 'gcode.3mf'));
    await atomicWrite(this.file(id, 'json'), JSON.stringify(project));
    return project;
  }

  withProjectLock(id, operation) {
    const previous = this.operations.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.operations.set(id, current);
    return current.finally(() => {
      if (this.operations.get(id) === current) this.operations.delete(id);
    });
  }

  remove(id) {
    return this.withProjectLock(id, async () => {
      await this.get(id);
      await rm(this.file(id, 'json'));
      await rm(this.file(id, 'gcode.3mf'), { force: true });
    });
  }

  move(id, folderId) {
    return this.withProjectLock(id, async () => {
      const project = { ...(await this.get(id)), folderId };
      await atomicWrite(this.file(id, 'json'), JSON.stringify(project));
      return project;
    });
  }
}
