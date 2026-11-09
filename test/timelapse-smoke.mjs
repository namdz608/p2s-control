// docker run --rm -i --entrypoint node p2s-control:timelapse-check --input-type=module < test/timelapse-smoke.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TimelapseService } from './server/services/timelapse.service.mjs';
import { CameraService } from './server/services/camera.service.mjs';

const execute = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), 'p2s-timelapse-smoke-'));
let frame = 0;
const upstream = createServer(async (req, res) => {
  if (req.method === 'PUT') return res.end();
  res.setHeader('content-type', 'image/jpeg');
  res.end(await readFile(path.join(directory, `source-${Math.min(++frame, 3)}.jpg`)));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
let timelapse;
try {
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=960x540:rate=1',
    '-frames:v',
    '3',
    '-threads',
    '1',
    path.join(directory, 'source-%d.jpg'),
  ]);
  const camera = new CameraService(
    { get: () => ({ host: '192.168.1.250', accessCode: 'test1234' }) },
    path.join(directory, 'camera'),
    `http://127.0.0.1:${upstream.address().port}`,
  );
  const printer = { snapshot: () => ({ fresh: false }), event() {} };
  timelapse = await TimelapseService.open(directory, { camera, printer });
  const clip = await timelapse.start({ name: 'Timelapse tổng hợp', interval: 10, fps: 24 });
  await timelapse.capture();
  await timelapse.capture();
  await timelapse.stop(clip.id);
  await timelapse.renderPromise;
  const video = await timelapse.video(clip.id);
  const { stdout } = await execute('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration',
    '-of',
    'json',
    video,
  ]);
  const probe = JSON.parse(stdout);
  assert.equal(probe.streams[0].codec_name, 'h264');
  assert.equal(probe.streams[0].width, 960);
  assert.equal(probe.streams[0].height, 540);
  assert.equal(probe.streams[0].r_frame_rate, '24/1');
  assert.equal(Number(probe.streams[0].nb_frames), 3);
  assert.equal(camera.viewers, 0);
  assert.equal(timelapse.snapshot().clips[0].status, 'ready');
  if (process.env.EXPORT_DIR)
    await copyFile(video, path.join(process.env.EXPORT_DIR, 'timelapse-sample.mp4'));
  console.log(
    `PASS: CameraService HTTP JPEG → 3 captures → FFmpeg H.264 MP4 960×540, 24 fps, ${probe.format.duration}s; camera viewers released. No physical printer connection.`,
  );
} finally {
  await timelapse?.close();
  await new Promise((resolve) => upstream.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
