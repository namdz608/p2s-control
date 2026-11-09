import { rm, rename, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { TimelapseModel } from '../models/timelapse.model.mjs';
import { TimelapseEncoder } from './timelapse-encoder.service.mjs';
import { AppError } from '../errors/app-error.mjs';
import { atomicWrite } from '../utils/atomic-file.mjs';

const defaults = {
  maxFrames: 10000,
  maxClipBytes: 1024 ** 3,
  maxStorageBytes: 5 * 1024 ** 3,
  maxDurationMs: 24 * 3600000,
  maxClips: 100,
  minFreeBytes: 128 * 1024 ** 2,
};
const options = (input) => {
  if (!Number.isInteger(input?.interval) || input.interval < 2 || input.interval > 300)
    throw new AppError('Khoảng chụp phải là số nguyên từ 2 đến 300 giây.');
  if (!Number.isInteger(input.fps) || input.fps < 1 || input.fps > 60)
    throw new AppError('Tốc độ video phải là số nguyên từ 1 đến 60 fps.');
  return { interval: input.interval, fps: input.fps };
};

export async function captureJpeg(camera, signal) {
  const opened = await camera.open({
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)].filter(Boolean)),
  });
  let reader;
  try {
    if (!opened.response.headers.get('content-type')?.toLowerCase().startsWith('image/jpeg'))
      throw new AppError('Camera chưa trả về ảnh JPEG hợp lệ.', 502);
    reader = opened.response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5 * 1024 ** 2) throw new AppError('Ảnh camera vượt giới hạn 5 MB.', 502);
      chunks.push(value);
    }
    const data = Buffer.concat(chunks);
    if (
      data.length < 4 ||
      data.readUInt16BE(0) !== 0xffd8 ||
      data.readUInt16BE(data.length - 2) !== 0xffd9
    )
      throw new AppError('Ảnh camera bị thiếu hoặc không hợp lệ.', 502);
    return data;
  } finally {
    await reader?.cancel().catch(() => {});
    opened.release();
  }
}

export class TimelapseService {
  static async open(directory, dependencies) {
    return new TimelapseService(await TimelapseModel.open(directory), dependencies);
  }
  constructor(
    model,
    { camera, printer, queue, encoder = new TimelapseEncoder(), capture, limits = {} },
  ) {
    this.model = model;
    this.printer = printer;
    this.queue = queue;
    this.encoder = encoder;
    this.captureFrame = capture || ((signal) => captureJpeg(camera, signal));
    this.limits = { ...defaults, ...limits };
    this.activeId = null;
    this.starting = false;
    this.closing = false;
    this.suppressedKey = null;
    this.autoError = '';
  }
  get busy() {
    return this.starting || this.activeId !== null;
  }
  public(clip) {
    const { jobKey, ...value } = clip;
    return { ...value, duration: clip.frames / clip.fps };
  }
  snapshot() {
    return {
      settings: { ...this.model.settings },
      busy: this.busy,
      active: this.activeId ? this.public(this.model.get(this.activeId)) : null,
      clips: this.model.clips.map((clip) => this.public(clip)),
      limits: this.limits,
      usedBytes: this.model.clips.reduce((bytes, clip) => bytes + clip.frameBytes + clip.size, 0),
      autoError: this.autoError,
    };
  }
  async space(extra = 0) {
    const used = this.snapshot().usedBytes;
    if (used + extra > this.limits.maxStorageBytes)
      throw new AppError(
        'Thư viện timelapse đã đạt giới hạn dung lượng. Tải và xóa video cũ trước khi ghi tiếp.',
        409,
      );
    const disk = await statfs(this.model.directory);
    if (disk.bavail * disk.bsize < this.limits.minFreeBytes + extra)
      throw new AppError('Server không còn đủ dung lượng trống để ghi timelapse.', 409);
  }
  async updateSettings(input) {
    const timing = options(input);
    if (typeof input.auto !== 'boolean') throw new AppError('Chọn bật hoặc tắt tự ghi timelapse.');
    this.model.settings = { auto: input.auto, ...timing };
    this.autoError = '';
    this.suppressedKey = null;
    await this.model.save();
    if (!input.auto && this.activeId && this.model.get(this.activeId).mode === 'auto')
      await this.stop(this.activeId, { reason: 'Đã tắt tự ghi timelapse.' });
    return this.snapshot();
  }
  async start(input, { mode = 'manual', jobKey = null } = {}) {
    const timing = options(input);
    if (this.printer.configPending)
      throw new AppError('Đang đổi cấu hình máy in. Đợi kết nối ổn định trước khi ghi.', 409);
    if (this.busy || this.closing)
      throw new AppError(
        'Đang ghi hoặc ghép video hiện tại. Đợi hoàn tất trước khi ghi tiếp.',
        409,
      );
    if (this.model.clips.length >= this.limits.maxClips)
      throw new AppError('Thư viện đã đủ 100 bản ghi. Xóa video cũ trước khi ghi tiếp.', 409);
    this.starting = true;
    let clip;
    try {
      if (!(await this.encoder.available()))
        throw new AppError(
          'Server chưa có FFmpeg với libx264. Cập nhật image Docker hoặc cài FFmpeg trước khi ghi.',
          503,
        );
      await this.space();
      if (this.closing) throw new AppError('Server đang dừng.', 409);
      if (mode === 'auto' && (!this.model.settings.auto || this.printKey() !== jobKey))
        throw new AppError('Tự ghi đã tắt hoặc tác vụ in đã thay đổi.', 409);
      const name =
        typeof input.name === 'string'
          ? input.name
              .replace(/[\x00-\x1f]/g, '')
              .trim()
              .slice(0, 100)
          : '';
      clip = await this.model.create({
        ...timing,
        mode,
        jobKey,
        name: name || `Timelapse ${new Date().toLocaleString('vi-VN')}`,
      });
      if (
        this.closing ||
        (mode === 'auto' && (!this.model.settings.auto || this.printKey() !== jobKey))
      )
        throw new AppError('Server đã dừng hoặc yêu cầu tự ghi đã thay đổi.', 409);
      this.activeId = clip.id;
      this.captureAbort = new AbortController();
      await this.capture();
      this.schedule();
      this.printer.event('Đã bắt đầu ghi timelapse trên server.');
      return this.public(clip);
    } catch (error) {
      if (clip) {
        clip.status = this.closing ? 'interrupted' : 'failed';
        clip.message = error.message;
        await this.model.save();
      }
      this.activeId = null;
      throw error;
    } finally {
      this.starting = false;
    }
  }
  schedule() {
    if (this.timer || this.closing || !this.activeId) return;
    const clip = this.model.get(this.activeId);
    if (clip.status !== 'recording') return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.capture();
      } catch {
        /* Initial camera errors are also stored in the clip. */
      }
      this.schedule();
    }, clip.interval * 1000);
    this.timer.unref();
  }
  async capture() {
    if (this.capturePromise) return this.capturePromise;
    if (!this.activeId || this.closing) return;
    const clip = this.model.get(this.activeId);
    if (clip.status !== 'recording') return;
    this.capturePromise = this.captureOne(clip);
    let reason;
    try {
      reason = await this.capturePromise;
    } finally {
      this.capturePromise = null;
    }
    if (reason && !this.closing) await this.stop(clip.id, { reason });
  }
  async captureOne(clip) {
    if (
      clip.frames >= this.limits.maxFrames ||
      clip.frameBytes >= this.limits.maxClipBytes ||
      Date.now() - Date.parse(clip.startedAt) >= this.limits.maxDurationMs
    )
      return 'Đã dừng ghi khi đạt giới hạn ảnh, dung lượng hoặc 24 giờ.';
    try {
      await this.space();
      const frame = await this.captureFrame(this.captureAbort.signal);
      if (this.closing) return;
      if (clip.frameBytes + frame.length > this.limits.maxClipBytes)
        return 'Đã đạt giới hạn dung lượng bản ghi.';
      await this.space(frame.length);
      await atomicWrite(
        path.join(
          this.model.framesDirectory(clip.id),
          `frame-${String(clip.frames + 1).padStart(8, '0')}.jpg`,
        ),
        frame,
      );
      clip.frames++;
      clip.frameBytes += frame.length;
      clip.lastFrameAt = new Date().toISOString();
      clip.lastError = '';
      clip.consecutiveFailures = 0;
      await this.model.save();
    } catch (error) {
      clip.missedFrames++;
      clip.lastError = error.message;
      clip.consecutiveFailures = (clip.consecutiveFailures || 0) + 1;
      await this.model.save();
      if (!clip.frames) throw error;
      if (clip.consecutiveFailures >= 5 || error.status === 409)
        return `Đã dừng ghi: ${error.message}`;
    }
  }
  async stop(id, { reason = 'Đã dừng ghi timelapse.', suppress = true } = {}) {
    const clip = this.model.get(id);
    if (clip.status === 'rendering') return this.public(clip);
    if (this.stopPromise) return this.stopPromise;
    if (id !== this.activeId || clip.status !== 'recording')
      throw new AppError('Bản ghi này không đang ghi hình.', 409);
    if (suppress) this.suppressedKey = this.printKey();
    clearTimeout(this.timer);
    this.timer = null;
    clip.status = 'stopping';
    this.stopPromise = (async () => {
      await this.capturePromise;
      clip.endedAt = new Date().toISOString();
      clip.message = reason;
      await this.beginRender(clip);
      return this.public(clip);
    })();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }
  async render(id) {
    if (this.busy || this.closing) throw new AppError('Đang ghi hoặc ghép video khác.', 409);
    const clip = this.model.get(id);
    if (!['interrupted', 'failed'].includes(clip.status))
      throw new AppError('Bản ghi này không cần ghép lại.', 409);
    this.starting = true;
    try {
      if (!(await this.encoder.available()))
        throw new AppError('Không tìm thấy FFmpeg với libx264.', 503);
      if (this.closing) throw new AppError('Server đang dừng.', 409);
      this.activeId = id;
      await this.beginRender(clip);
      return this.public(clip);
    } finally {
      this.starting = false;
    }
  }
  async beginRender(clip) {
    if (clip.frames < 2) {
      clip.status = 'failed';
      clip.message = 'Cần ít nhất 2 ảnh để ghép video. Bản ghi chưa đủ ảnh.';
      this.activeId = null;
      await this.model.save();
      return;
    }
    clip.status = 'rendering';
    await this.model.save();
    if (this.closing) {
      clip.status = 'interrupted';
      clip.message = 'Server đã dừng trước khi ghép video.';
      this.activeId = null;
      await this.model.save();
      return;
    }
    this.renderAbort = new AbortController();
    this.renderPromise = this.encodeClip(clip);
  }
  async encodeClip(clip) {
    const temporary = path.join(this.model.folder(clip.id), 'video.pending.mp4');
    try {
      await this.space(clip.frameBytes);
      await this.encoder.encode(
        this.model.framesDirectory(clip.id),
        temporary,
        clip.fps,
        this.renderAbort.signal,
      );
      const file = await stat(temporary);
      if (!file.size) throw new AppError('FFmpeg chưa tạo được video.', 502);
      if (this.snapshot().usedBytes + file.size > this.limits.maxStorageBytes)
        throw new AppError(
          'Video vượt dung lượng còn lại của thư viện. Xóa video cũ rồi bấm Ghép lại.',
          409,
        );
      await rename(temporary, this.model.file(clip.id));
      clip.status = 'ready';
      clip.size = file.size;
      await this.model.save();
      await rm(this.model.framesDirectory(clip.id), { recursive: true, force: true });
      clip.frameBytes = 0;
      await this.model.save();
      this.printer.event('Video timelapse đã sẵn sàng để xem và tải xuống.');
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      clip.status = this.closing ? 'interrupted' : 'failed';
      clip.message = this.closing
        ? 'Server đã dừng khi ghép. Bấm Ghép lại để tạo video từ ảnh đã lưu.'
        : error.message;
      await this.model.save();
    } finally {
      this.activeId = null;
    }
  }
  async video(id) {
    const clip = this.model.get(id);
    if (clip.status !== 'ready')
      throw new AppError('Video chưa sẵn sàng. Đợi ghép xong hoặc bấm Ghép lại.', 409);
    const file = this.model.file(id);
    try {
      await stat(file);
    } catch {
      throw new AppError('Không tìm thấy tệp video trên server.', 404);
    }
    return file;
  }
  async remove(id) {
    if (id === this.activeId) throw new AppError('Dừng ghi và đợi ghép xong trước khi xóa.', 409);
    await this.model.remove(id);
  }
  printKey() {
    const state = this.printer.snapshot();
    const queue = this.queue?.snapshot();
    if (
      !state.fresh ||
      !['PREPARE', 'RUNNING', 'SLICING', 'PAUSE'].includes(state.status) ||
      !state.task ||
      state.maintenance?.active ||
      this.printer.raw?.print?.gcode_file?.includes('auto_cali_for_user')
    )
      return null;
    return queue?.active ? `queue:${queue.current}:${state.task}` : state.task;
  }
  async tick() {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      const state = this.printer.snapshot();
      if (!state.fresh) return;
      const key = this.printKey();
      if (!key) this.suppressedKey = null;
      const active = this.activeId && this.model.get(this.activeId);
      if (
        active?.mode === 'auto' &&
        active.status === 'recording' &&
        (!this.model.settings.auto || !key || active.jobKey !== key)
      )
        await this.stop(active.id, {
          reason:
            state.status === 'FAILED'
              ? 'Bản in có lỗi; đã kết thúc ghi.'
              : 'Bản in đã kết thúc hoặc chuyển tác vụ.',
          suppress: false,
        });
      if (this.model.settings.auto && key && key !== this.suppressedKey && !this.busy) {
        try {
          await this.start(
            { ...this.model.settings, name: state.task },
            { mode: 'auto', jobKey: key },
          );
          this.autoError = '';
        } catch (error) {
          if (this.model.settings.auto && !this.closing) {
            this.suppressedKey = key;
            this.autoError = `Không tự ghi được bản in này: ${error.message} Khắc phục camera rồi bấm Bắt đầu ghi thủ công.`;
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  watch() {
    this.watchTimer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 2000);
    this.watchTimer.unref();
  }
  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    clearInterval(this.watchTimer);
    this.captureAbort?.abort();
    this.renderAbort?.abort();
    await this.capturePromise?.catch(() => {});
    await this.renderPromise?.catch(() => {});
    if (this.activeId) {
      const clip = this.model.get(this.activeId);
      clip.status = 'interrupted';
      clip.message = 'Server đã dừng. Bấm Ghép lại để tạo video từ ảnh đã lưu.';
      this.activeId = null;
      await this.model.save();
    }
  }
}
