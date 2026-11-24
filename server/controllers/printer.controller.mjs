import { AppError } from '../errors/app-error.mjs';

function parseByteRange(header, size) {
  if (header === undefined) return null;
  const match = typeof header === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === '' && match[2] === '')) return { invalid: true };
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}
import { PrinterHealthService } from '../services/printer-health.service.mjs';
import {
  attachStorageLabels,
  PrinterStorageService,
} from '../services/printer-storage.service.mjs';

export class PrinterController {
  constructor(printer, settings, queue, timelapse, storage, projects = null) {
    this.printer = printer;
    this.settings = settings;
    this.queue = queue;
    this.health = new PrinterHealthService(printer);
    this.timelapse = timelapse;
    this.storage =
      storage ?? new PrinterStorageService(settings.config, printer, undefined, projects);
    this.projects = projects;
  }

  show = (_req, res) => {
    void this.health.resolveFaults();
    res.json({
      printer: this.printer.snapshot(),
      settings: this.settings.get(),
      events: this.printer.events,
      queue: this.queue?.snapshot(),
      health: this.health.snapshot(),
      timelapse: this.timelapse?.snapshot(),
    });
  };

  diagnostics = async (_req, res) => {
    res.json(await this.health.run(this.settings));
  };

  config = (_req, res) => {
    res.json(this.settings.get());
  };

  updateConfig = async (req, res) => {
    res.json(await this.settings.update(req.body));
  };

  reconnect = async (_req, res) => {
    await this.settings.reconnect();
    res.json({ ok: true });
  };

  listStorage = async (req, res) => {
    const path = req.query.path === undefined ? '/' : req.query.path;
    const listing = await this.storage.list(path);
    const projects = this.projects?.list ? await this.projects.list() : [];
    res.json({ ...listing, entries: attachStorageLabels(listing.entries, projects) });
  };

  openStorageVideo = async (req, res, next) => {
    try {
      const file = await this.storage.openVideo(req.query.path);
      const range = parseByteRange(req.headers.range, file.size);
      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private');
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
      if (range?.invalid) {
        res.status(416).setHeader('Content-Range', `bytes */${file.size}`).end();
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? file.size - 1;
      const length = end - start + 1;
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
      }
      res.setHeader('Content-Length', String(length));
      await this.storage.writeVideo(file.path, res, start, length);
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      next(error);
    }
  };

  deleteStorage = async (req, res) => {
    const confirmed = req.body?.confirmed === true;
    if (Array.isArray(req.body?.paths)) {
      res.json(await this.storage.removeMany(req.body.paths, confirmed));
      return;
    }
    res.json(await this.storage.remove(req.body?.path, confirmed));
  };

  command = async (req, res) => {
    if (
      ['nozzle', 'bed'].includes(req.body?.type) &&
      req.body?.value > 0 &&
      req.body?.confirmed !== true
    )
      throw new AppError('Cần xác nhận thay đổi nhiệt độ.');
    if (req.body?.type === 'stop' && req.body?.confirmed !== true)
      throw new AppError('Cần xác nhận dừng tác vụ in.');
    if (req.body?.type === 'stop') this.queue?.cancel();
    const result = await this.printer.command(req.body ?? {});
    if (req.body?.type === 'filamentChange') {
      res.status(202).json({ ok: true, filamentChange: result });
      return;
    }
    res.status(202).json({ ok: true, message: 'Đã gửi yêu cầu. Chờ máy in cập nhật trạng thái.' });
  };
}
