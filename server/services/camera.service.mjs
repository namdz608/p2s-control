import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../utils/atomic-file.mjs';
import { AppError } from '../errors/app-error.mjs';

export class CameraService {
  constructor(config, directory, baseURL = 'http://camera:1984') {
    this.config = config;
    this.directory = directory;
    this.baseURL = baseURL;
    this.applied = '';
    this.applying = null;
    this.viewers = 0;
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'go2rtc.yaml');
    const printer = this.config.get();
    const streams = printer ? { p2s: this.sources(printer) } : {};
    await atomicWrite(
      file,
      JSON.stringify({
        api: { listen: ':1984', origin: '' },
        rtsp: { listen: '127.0.0.1:8554' },
        webrtc: { listen: '' },
        log: { level: 'fatal' },
        ffmpeg: { mjpeg: '-c:v mjpeg -vf scale=960:540,fps=5' },
        streams,
      }),
    );
  }
  sources(config) {
    return [
      `rtsps://bblp:${encodeURIComponent(config.accessCode)}@${config.host}:322/streaming/live/1`,
      'ffmpeg:p2s#video=mjpeg',
    ];
  }
  async configure() {
    const config = this.config.get();
    if (!config) throw new AppError('Thêm máy in trước khi mở camera.', 409);
    const key = `${config.host}:${config.accessCode}`;
    if (this.applied === key) return;
    if (this.applying) await this.applying;
    if (this.applied === key) return;
    this.applying = (async () => {
      const params = new URLSearchParams({ name: 'p2s' });
      for (const source of this.sources(config)) params.append('src', source);
      const response = await fetch(`${this.baseURL}/api/streams?${params}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) throw new Error('CAMERA_CONFIG');
      this.applied = key;
    })();
    try {
      await this.applying;
    } catch {
      throw new AppError('Dịch vụ camera chưa sẵn sàng. Thử lại sau vài giây.', 503);
    } finally {
      this.applying = null;
    }
  }
  async open({ stream = false, signal } = {}) {
    if (this.viewers >= 3)
      throw new AppError('Camera đã có 3 lượt xem. Đóng một cửa sổ để tiếp tục.', 429);
    this.viewers++;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20000);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      this.viewers--;
      abort.abort();
    };
    try {
      await this.configure();
      const upstream = await fetch(
        `${this.baseURL}/api/${stream ? 'stream.mjpeg?src=p2s' : 'frame.jpeg?src=p2s&width=960&height=540'}`,
        { signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal },
      );
      clearTimeout(timeout);
      if (!upstream.ok || !upstream.body) throw new Error('CAMERA_STREAM');
      return { response: upstream, release };
    } catch {
      release();
      throw new AppError(
        'Chưa nhận được camera. Bật LAN Only Liveview trên P2S và kiểm tra cổng 322.',
        502,
      );
    }
  }
}
