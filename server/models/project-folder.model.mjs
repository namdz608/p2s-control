import { mkdir, readdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../errors/app-error.mjs';
import { atomicWrite } from '../utils/atomic-file.mjs';

export class ProjectFolderModel {
  static async open(directory) {
    const folder = path.join(directory, 'project-folders');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    return new ProjectFolderModel(folder);
  }

  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }

  async list() {
    const items = [];
    for (const file of await readdir(this.directory)) {
      if (/^[a-f0-9]{32}\.json$/.test(file))
        items.push(JSON.parse(await readFile(path.join(this.directory, file), 'utf8')));
    }
    return items.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
  }

  async get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))
      throw new AppError('Không tìm thấy thư mục.', 404);
    try {
      return JSON.parse(await readFile(path.join(this.directory, `${id}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new AppError('Không tìm thấy thư mục.', 404);
      throw error;
    }
  }

  add(name) {
    // Serialize the duplicate check and write when multiple tabs create folders together.
    const task = this.pending.then(async () => {
      const key = name.normalize('NFC').toLocaleLowerCase('vi');
      if (
        (await this.list()).some(
          (item) => item.name.normalize('NFC').toLocaleLowerCase('vi') === key,
        )
      )
        throw new AppError('Tên thư mục đã tồn tại.', 409);
      const folder = { id: randomBytes(16).toString('hex'), name };
      await atomicWrite(path.join(this.directory, `${folder.id}.json`), JSON.stringify(folder));
      return folder;
    });
    this.pending = task.catch(() => {});
    return task;
  }
}
