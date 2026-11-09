import { AppError } from '../errors/app-error.mjs';

export class TimelapseController {
  constructor(service) {
    this.service = service;
  }
  ready() {
    if (!this.service) throw new AppError('Dịch vụ timelapse chưa sẵn sàng.', 503);
    return this.service;
  }
  show = (_req, res) => res.json(this.ready().snapshot());
  settings = async (req, res) => res.json(await this.ready().updateSettings(req.body));
  start = async (req, res) => res.status(201).json(await this.ready().start(req.body));
  stop = async (req, res) => res.status(202).json(await this.ready().stop(req.params.id));
  render = async (req, res) => res.status(202).json(await this.ready().render(req.params.id));
  remove = async (req, res) => {
    await this.ready().remove(req.params.id);
    res.json({ ok: true });
  };
  video = async (req, res, next) => {
    const file = await this.ready().video(req.params.id);
    const done = (error) => {
      if (error && !res.destroyed) next(error);
    };
    if (req.query.download === '1') res.download(file, `timelapse-${req.params.id}.mp4`, done);
    else res.sendFile(file, { headers: { 'Content-Type': 'video/mp4' } }, done);
  };
}
