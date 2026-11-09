import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { AppError } from '../errors/app-error.mjs';

const execute = promisify(execFile);
export class TimelapseEncoder {
  constructor(binary = 'ffmpeg') {
    this.binary = binary;
  }
  async available() {
    try {
      const { stdout } = await execute(this.binary, ['-hide_banner', '-h', 'encoder=libx264'], {
        timeout: 5000,
        maxBuffer: 256 * 1024,
      });
      return stdout.includes('Encoder libx264');
    } catch {
      return false;
    }
  }
  async encode(directory, output, fps, signal) {
    if (signal?.aborted) throw new AppError('Đã ngừng ghép video.', 409);
    await new Promise((resolve, reject) => {
      const child = spawn(
        this.binary,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-framerate',
          String(fps),
          '-start_number',
          '1',
          '-i',
          path.join(directory, 'frame-%08d.jpg'),
          '-an',
          '-vf',
          'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-threads',
          '2',
          '-movflags',
          '+faststart',
          output,
        ],
        { stdio: 'ignore' },
      );
      const abort = () => child.kill('SIGKILL');
      const timeout = setTimeout(abort, 5 * 60000);
      timeout.unref();
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', () =>
        reject(new AppError('Không chạy được FFmpeg. Kiểm tra cài đặt trên server.', 503)),
      );
      child.once('close', (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (code === 0 && !signal?.aborted) resolve();
        else
          reject(
            new AppError('Không ghép được video timelapse. Ảnh được giữ lại để thử ghép lại.', 502),
          );
      });
    });
  }
}
