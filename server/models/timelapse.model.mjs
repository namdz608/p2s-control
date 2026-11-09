import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWrite } from '../utils/atomic-file.mjs';
import { AppError } from '../errors/app-error.mjs';

export class TimelapseModel {
  static async open(directory) {
    const model = new TimelapseModel(path.join(directory, 'timelapses'));
    await mkdir(model.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(model.index, 'utf8'));
      if (!Array.isArray(saved.clips) || !saved.settings) throw new Error('INVALID_INDEX');
      model.settings = saved.settings;
      model.clips = saved.clips;
      for (const clip of model.clips) {
        model.folder(clip.id);
        if (['recording', 'stopping', 'rendering'].includes(clip.status)) {
          clip.status = 'interrupted';
          clip.message = 'Server đã dừng. Ảnh đã chụp được giữ lại; bấm Ghép lại để tạo video.';
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error('Không đọc được thư viện timelapse. Kiểm tra dữ liệu đã lưu.');
    }
    await model.save();
    return model;
  }
  constructor(directory) {
    this.directory = directory;
    this.index = path.join(directory, 'index.json');
    this.settings = { auto: false, interval: 10, fps: 24 };
    this.clips = [];
    this.pending = Promise.resolve();
  }
  folder(id) {
    if (!/^[a-f0-9]{32}$/.test(id || '')) throw new AppError('Mã video không hợp lệ.', 400);
    return path.join(this.directory, id);
  }
  framesDirectory(id) {
    return path.join(this.folder(id), 'frames');
  }
  file(id) {
    return path.join(this.folder(id), 'video.mp4');
  }
  get(id) {
    this.folder(id);
    const clip = this.clips.find((item) => item.id === id);
    if (!clip) throw new AppError('Không tìm thấy video timelapse.', 404);
    return clip;
  }
  async create(input) {
    const clip = {
      ...input,
      id: randomBytes(16).toString('hex'),
      frames: 0,
      frameBytes: 0,
      size: 0,
      missedFrames: 0,
      status: 'recording',
      startedAt: new Date().toISOString(),
      message: 'Đang chụp timelapse.',
    };
    await mkdir(this.framesDirectory(clip.id), { recursive: true, mode: 0o700 });
    this.clips.unshift(clip);
    await this.save();
    return clip;
  }
  save() {
    const json = JSON.stringify({ settings: this.settings, clips: this.clips });
    this.pending = this.pending.catch(() => {}).then(() => atomicWrite(this.index, json));
    return this.pending;
  }
  async remove(id) {
    this.get(id);
    await rm(this.folder(id), { recursive: true, force: true });
    this.clips = this.clips.filter((item) => item.id !== id);
    await this.save();
  }
}
