import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraService } from '../server/services/camera.service.mjs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('camera admits at most three simultaneous viewers, including while configuring', async () => {
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const camera = new CameraService({}, '/unused', 'http://127.0.0.1:1');
  camera.configure = () => hold;
  const requests = Array.from({ length: 4 }, () =>
    camera.open().then(
      () => 200,
      (error) => error.status,
    ),
  );
  release();
  const statuses = await Promise.all(requests);
  assert.equal(
    statuses.filter((status) => status === 429).length,
    1,
    'fourth viewer must be rejected',
  );
  assert.equal(camera.viewers, 0);
});

test('camera source is accepted by go2rtc API that rejects sources containing spaces', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-camera-'));
  const upstream = createServer((req, res) => {
    const sources = new URL(req.url, 'http://localhost').searchParams.getAll('src');
    res.statusCode = sources.some((source) => source.includes(' ')) ? 400 : 200;
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const camera = new CameraService(
    { get: () => ({ host: '192.168.1.25', accessCode: 'test1234' }) },
    dir,
    `http://127.0.0.1:${upstream.address().port}`,
  );
  try {
    await camera.init();
    await camera.configure();
    const config = JSON.parse(await readFile(path.join(dir, 'go2rtc.yaml'), 'utf8'));
    assert.match(config.ffmpeg.mjpeg, /scale=960:540,fps=5/);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('camera service holds a viewer until the HTTP controller releases the source', async () => {
  const upstream = createServer((req, res) => {
    if (req.method === 'PUT') return res.end();
    res.setHeader('content-type', 'image/jpeg');
    res.end(Buffer.from([255, 216, 255, 217]));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const camera = new CameraService(
    { get: () => ({ host: '192.168.1.25', accessCode: 'test1234' }) },
    '/unused',
    `http://127.0.0.1:${upstream.address().port}`,
  );
  try {
    const opened = await camera.open();
    assert.equal(camera.viewers, 1);
    assert.deepEqual(
      [...new Uint8Array(await opened.response.arrayBuffer())],
      [255, 216, 255, 217],
    );
    opened.release();
    opened.release();
    assert.equal(camera.viewers, 0);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});
