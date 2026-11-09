import { rm } from 'node:fs/promises';
import { AppError } from '../errors/app-error.mjs';

export class ProjectController {
  constructor(projects) {
    this.projects = projects;
  }

  index = async (_req, res) => {
    res.json(await this.projects.list());
  };

  preview = async (req, res) => {
    const image = await this.projects.preview(req.params.id);
    res.setHeader('Content-Type', image.type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', 'inline');
    res.send(image.body);
  };

  store = async (req, res) => {
    if (!req.file) throw new AppError('Chưa chọn tệp in.');
    try {
      res.status(201).json(await this.projects.add(req.file));
    } finally {
      await rm(req.file.path, { force: true });
    }
  };

  destroy = async (req, res) => {
    await this.projects.remove(req.params.id);
    res.json({ ok: true });
  };

  queueStatus = (_req, res) => {
    res.json(this.projects.queue.snapshot());
  };

  startQueue = async (req, res) => {
    res.status(202).json(await this.projects.queue.start(req.body));
  };

  cancelQueue = (_req, res) => {
    res.json(this.projects.queue.cancel());
  };

  start = async (req, res) => {
    await this.projects.start(req.params.id, req.body);
    res.status(202).json({ ok: true, message: 'Đã gửi tác vụ. Chờ máy in xác nhận.' });
  };
}
