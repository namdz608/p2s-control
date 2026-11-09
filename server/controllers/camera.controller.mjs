import { Readable } from 'node:stream';
import { AppError } from '../errors/app-error.mjs';

export class CameraController {
  constructor(camera) {
    this.camera = camera;
  }

  snapshot = (req, res) => this.pipe(req, res, false);
  stream = (req, res) => this.pipe(req, res, true);

  async pipe(_req, res, stream) {
    const abort = new AbortController();
    let source;
    let release;
    const close = () => {
      abort.abort();
      source?.destroy();
    };
    res.once('close', close);
    try {
      const opened = await this.camera.open({ stream, signal: abort.signal });
      release = opened.release;
      if (res.destroyed) return;
      res.setHeader(
        'Content-Type',
        opened.response.headers.get('content-type') ??
          (stream ? 'multipart/x-mixed-replace; boundary=frame' : 'image/jpeg'),
      );
      res.setHeader('X-Accel-Buffering', 'no');
      source = Readable.fromWeb(opened.response.body);
      await new Promise((resolve, reject) => {
        source.once('error', reject);
        res.once('close', resolve);
        source.once('end', resolve);
        source.pipe(res);
      });
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          'Chưa nhận được camera. Bật LAN Only Liveview trên P2S và kiểm tra cổng 322.',
          502,
        );
      }
      if (!res.destroyed) res.end();
    } finally {
      res.off('close', close);
      source?.destroy();
      release?.();
      abort.abort();
    }
  }
}
