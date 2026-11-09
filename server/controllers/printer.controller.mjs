import { AppError } from '../errors/app-error.mjs';
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

  deleteStorage = async (req, res) => {
    res.json(await this.storage.remove(req.body?.path, req.body?.confirmed === true));
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
    await this.printer.command(req.body ?? {});
    res.status(202).json({ ok: true, message: 'Đã gửi yêu cầu. Chờ máy in cập nhật trạng thái.' });
  };
}
