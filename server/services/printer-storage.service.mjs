import { FileType } from 'basic-ftp';
import { AppError } from '../errors/app-error.mjs';
import { withPrinterFtp } from './printer-file.service.mjs';

const busyStates = new Set(['RUNNING', 'PAUSE', 'PREPARE', 'SLICING']);
const visibleLimit = 500;
const readLimit = 5000;
const deleteConcurrency = 4;

async function runPool(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

export function resolveStoragePath(input = '/') {
  if (typeof input !== 'string') throw new AppError('Đường dẫn USB không hợp lệ.');
  const raw = input.trim();
  if (
    raw.length === 0 ||
    raw.length > 512 ||
    !raw.startsWith('/') ||
    raw.includes('\\') ||
    /[\u0000-\u001f]/.test(raw)
  )
    throw new AppError('Đường dẫn USB không hợp lệ.');
  if (raw !== '/' && raw.endsWith('/')) throw new AppError('Đường dẫn USB không hợp lệ.');
  const parts = raw
    .slice(1)
    .split('/')
    .filter((part) => part.length > 0);
  if (raw !== '/' && parts.length === 0) throw new AppError('Đường dẫn USB không hợp lệ.');
  if (parts.some((part) => part === '.' || part === '..'))
    throw new AppError('Đường dẫn USB không hợp lệ.');
  return `/${parts.join('/')}`;
}

export function attachStorageLabels(entries, projects = []) {
  const names = new Map();
  for (const project of projects) {
    if (project?.id && project?.name) names.set(String(project.id).toLowerCase(), project.name);
  }
  return entries.map((entry) => {
    const match = /^([a-f0-9]{32})\.gcode\.3mf$/i.exec(entry.name || '');
    const label = match ? names.get(match[1].toLowerCase()) : undefined;
    return label ? { ...entry, label } : entry;
  });
}

export function storageFileInUse(filePath, printer, projects = []) {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const [labeled] = attachStorageLabels([{ name, path: filePath, type: 'file' }], projects);
  const print = printer.raw?.print || {};
  const haystack = [print.gcode_file, print.subtask_name, print.file]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase();
  return [name, labeled?.label]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .some((value) => haystack.includes(value.toLowerCase()));
}

export function ftpPath(storagePath) {
  return storagePath === '/' ? '' : storagePath.slice(1);
}

export function describeStorageEntry(directory, info) {
  const name = info?.name;
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\') || /[\u0000-\u001f]/.test(name)) return null;
  const type =
    info.type === FileType.Directory ? 'directory' : info.type === FileType.File ? 'file' : 'other';
  const base = directory === '/' ? '' : directory;
  const size = Number.isFinite(info.size) && info.size >= 0 ? info.size : 0;
  const modifiedAt =
    info.modifiedAt instanceof Date && !Number.isNaN(info.modifiedAt.getTime())
      ? info.modifiedAt.toISOString()
      : null;
  return { name, path: `${base}/${name}`, type, size, modifiedAt };
}

function byName(left, right) {
  if (left.type === 'directory' && right.type !== 'directory') return -1;
  if (right.type === 'directory' && left.type !== 'directory') return 1;
  return left.name.localeCompare(right.name, 'vi', { numeric: true, sensitivity: 'base' });
}

export class PrinterStorageService {
  constructor(config, printer, ftp = withPrinterFtp, projects = null) {
    this.config = config;
    this.printer = printer;
    this.ftp = ftp;
    this.projects = projects;
  }

  async useFtp(task, options) {
    const config = this.config.get();
    if (!config?.host || !config.accessCode)
      throw new AppError('Chưa lưu máy in. Vào Kết nối máy in trước khi kiểm tra USB.', 409);
    try {
      return await this.ftp(config, task, options);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'Không truy cập được USB máy in qua FTPS cổng 990. Kiểm tra Developer Mode, USB và kết nối.',
        502,
      );
    }
  }

  async read(input = '/') {
    const directory = resolveStoragePath(input);
    const listed = await this.useFtp((client) => client.list(ftpPath(directory)), { utf8: true });
    const entries = [];
    for (const info of Array.isArray(listed) ? listed : []) {
      const entry = describeStorageEntry(directory, info);
      if (entry) entries.push(entry);
    }
    if (entries.length > readLimit)
      throw new AppError('Thư mục USB có quá nhiều mục để đọc an toàn.', 409);
    entries.sort(byName);
    return { directory, entries };
  }

  async list(input = '/') {
    const { directory, entries } = await this.read(input);
    return {
      path: directory,
      parent: directory === '/' ? null : directory.slice(0, directory.lastIndexOf('/')) || '/',
      entries: entries.slice(0, visibleLimit),
      truncated: entries.length > visibleLimit,
    };
  }

  async remove(input, confirmed) {
    if (confirmed !== true) throw new AppError('Cần xác nhận trước khi xóa tệp trên USB.');
    const filePath = resolveStoragePath(input);
    if (filePath === '/') throw new AppError('Không xóa thư mục gốc của USB.');
    const state = this.printer.snapshot();
    if (this.printer.jobPending)
      throw new AppError('Đang gửi tệp in. Đợi xong rồi mới xóa tệp trên USB.', 409);
    const projects = this.projects?.list ? await this.projects.list() : [];
    if (busyStates.has(state.status) && storageFileInUse(filePath, this.printer, projects))
      throw new AppError('Tệp này đang được bản in dùng. Đợi máy in xong rồi mới xóa.', 409);
    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    const parent = filePath.slice(0, filePath.lastIndexOf('/')) || '/';
    const { entries } = await this.read(parent);
    const entry = entries.find((item) => item.name === name);
    if (!entry) throw new AppError('Không thấy tệp này trên USB.', 404);
    if (entry.type !== 'file')
      throw new AppError('Chỉ xóa được từng tệp. Thư mục trên USB được giữ nguyên.', 400);
    await this.useFtp((client) => client.remove(ftpPath(filePath)));
    this.printer.event?.(`Đã xóa tệp trên USB: ${name}`);
    return { ok: true, path: filePath };
  }

  async removeMany(inputs, confirmed) {
    if (confirmed !== true) throw new AppError('Cần xác nhận trước khi xóa tệp trên USB.');
    if (!Array.isArray(inputs) || inputs.length === 0)
      throw new AppError('Chọn ít nhất một tệp trước khi xóa.');
    if (inputs.length > visibleLimit) throw new AppError('Chọn quá nhiều tệp để xóa một lần.', 409);
    if (this.printer.jobPending)
      throw new AppError('Đang gửi tệp in. Đợi xong rồi mới xóa tệp trên USB.', 409);
    const state = this.printer.snapshot();
    const projects = this.projects?.list ? await this.projects.list() : [];
    const failed = [];
    const unique = [];
    const seen = new Set();
    for (const input of inputs) {
      let filePath;
      try {
        filePath = resolveStoragePath(input);
      } catch (error) {
        failed.push({ path: String(input ?? ''), error: error.message });
        continue;
      }
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      if (filePath === '/') {
        failed.push({ path: filePath, error: 'Không xóa thư mục gốc của USB.' });
        continue;
      }
      if (busyStates.has(state.status) && storageFileInUse(filePath, this.printer, projects)) {
        failed.push({
          path: filePath,
          error: 'Tệp này đang được bản in dùng. Đợi máy in xong rồi mới xóa.',
        });
        continue;
      }
      unique.push(filePath);
    }
    const byParent = new Map();
    for (const filePath of unique) {
      const parent = filePath.slice(0, filePath.lastIndexOf('/')) || '/';
      const name = filePath.slice(filePath.lastIndexOf('/') + 1);
      const group = byParent.get(parent) || [];
      group.push({ filePath, name });
      byParent.set(parent, group);
    }
    const listed = await runPool(
      [...byParent.entries()],
      deleteConcurrency,
      async ([parent, files]) => {
        try {
          const { entries } = await this.read(parent);
          return { parent, files, entries };
        } catch (error) {
          return { parent, files, error };
        }
      },
    );
    const ready = [];
    for (const group of listed) {
      if (group.error) {
        for (const file of group.files)
          failed.push({ path: file.filePath, error: group.error.message });
        continue;
      }
      const known = new Map(group.entries.map((entry) => [entry.name, entry]));
      for (const file of group.files) {
        const entry = known.get(file.name);
        if (!entry) {
          failed.push({ path: file.filePath, error: 'Không thấy tệp này trên USB.' });
          continue;
        }
        if (entry.type !== 'file') {
          failed.push({
            path: file.filePath,
            error: 'Chỉ xóa được từng tệp. Thư mục trên USB được giữ nguyên.',
          });
          continue;
        }
        ready.push(file);
      }
    }
    const outcomes = await runPool(ready, deleteConcurrency, async (file) => {
      try {
        await this.useFtp((client) => client.remove(ftpPath(file.filePath)));
        this.printer.event?.(`Đã xóa tệp trên USB: ${file.name}`);
        return { ok: true, path: file.filePath };
      } catch (error) {
        return { ok: false, path: file.filePath, error: error.message };
      }
    });
    const removed = [];
    for (const outcome of outcomes) {
      if (outcome.ok) removed.push(outcome.path);
      else failed.push({ path: outcome.path, error: outcome.error });
    }
    return { ok: failed.length === 0, removed, failed };
  }

  async removeOwnedCopy(projectId) {
    if (!/^[a-f0-9]{32}$/.test(projectId)) return { removed: false, reason: 'absent' };
    const config = this.config.get();
    if (!config?.host || !config.accessCode) return { removed: false, reason: 'unconfigured' };
    try {
      await this.remove(`/${projectId}.gcode.3mf`, true);
      return { removed: true, reason: 'removed' };
    } catch (error) {
      if (error instanceof AppError && error.status === 404)
        return { removed: false, reason: 'absent' };
      throw error;
    }
  }
}
