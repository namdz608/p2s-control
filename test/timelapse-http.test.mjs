import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../server/models/printer-config.model.mjs';
import { createApp } from '../server/app.mjs';

test('timelapse HTTP protects recordings, validates input, supports video ranges and never exposes frame paths', async () => {
  const { TimelapseService } = await import('../server/services/timelapse.service.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'p2s-timelapse-http-'));
  const config = await ConfigStore.open(directory);
  const printer = {
    snapshot: () => ({ fresh: false, connection: 'unconfigured' }),
    events: [],
    event() {},
  };
  const timelapse = await TimelapseService.open(directory, {
    printer,
    capture: async () => Buffer.from([255, 216, 255, 217]),
    encoder: {
      available: async () => true,
      encode: async (_frames, output) => writeFile(output, 'test-video-data'),
    },
  });
  const server = createApp({
    config,
    printer,
    projects: {},
    camera: {},
    timelapse,
    password: 'timelapse-test-password',
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = (url, method = 'GET', body, extra = {}) =>
    fetch(origin + url, {
      method,
      headers: { origin, cookie, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    for (const url of [
      '/api/v1/timelapses',
      '/api/v1/timelapses/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/video',
    ])
      assert.equal((await request(url)).status, 401);
    assert.equal((await request('/api/v1/timelapses/start', 'POST', {})).status, 401);
    const login = await request('/api/v1/auth/login', 'POST', {
      password: 'timelapse-test-password',
    });
    cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/v1/timelapses')).status, 200);
    assert.equal(
      (
        await request(
          '/api/v1/timelapses/settings',
          'PUT',
          { auto: true, interval: 10, fps: 24 },
          { origin: 'https://evil.invalid' },
        )
      ).status,
      403,
    );
    assert.equal(
      (await request('/api/v1/timelapses/settings', 'PUT', { auto: true, interval: 0, fps: 24 }))
        .status,
      400,
    );
    assert.equal(
      (await request('/api/v1/timelapses/settings', 'PUT', { auto: true, interval: 10, fps: 24 }))
        .status,
      200,
    );
    const start = await request('/api/v1/timelapses/start', 'POST', {
      name: 'Một bản in',
      interval: 10,
      fps: 24,
    });
    assert.equal(start.status, 201);
    const clip = await start.json();
    assert.equal(clip.status, 'recording');
    assert.equal((await request(`/api/v1/timelapses/${clip.id}`, 'DELETE')).status, 409);
    await timelapse.capture();
    assert.equal((await request(`/api/v1/timelapses/${clip.id}/stop`, 'POST', {})).status, 202);
    await timelapse.renderPromise;
    const video = await request(`/api/v1/timelapses/${clip.id}/video`, 'GET', undefined, {
      range: 'bytes=0-3',
    });
    assert.equal(video.status, 206);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    assert.equal(await video.text(), 'test');
    const download = await request(`/api/v1/timelapses/${clip.id}/video?download=1`);
    assert.match(download.headers.get('content-disposition'), /^attachment/);
    const state = await (await request('/api/v1/timelapses')).json();
    assert.equal(JSON.stringify(state).includes(directory), false);
    assert.equal((await request('/api/v1/timelapses/%2e%2e%2fsecret/video')).status, 400);
    assert.equal((await request(`/api/v1/timelapses/${clip.id}`, 'DELETE')).status, 200);
    assert.equal((await request(`/api/v1/timelapses/${clip.id}/video`)).status, 404);
  } finally {
    await timelapse.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
