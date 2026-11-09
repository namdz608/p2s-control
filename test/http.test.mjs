import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../server/models/printer-config.model.mjs';
import { createApp } from '../server/app.mjs';

test('HTTP requires authentication, rejects cross-origin writes, validates config and clears sessions on logout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-http-'));
  const config = await ConfigStore.open(dir);
  const printer = {
    snapshot: () => ({ connection: 'unconfigured', fresh: false }),
    events: [],
    jobPending: false,
    start: async () => {},
    close: async () => {},
    command: async () => {
      throw new Error('must not run');
    },
  };
  const app = createApp({
    config,
    printer,
    projects: { list: async () => [] },
    camera: {},
    password: 'local-test-password-123',
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options) => fetch(origin + url, options);
  try {
    assert.equal((await request('/api/state')).status, 401);
    assert.equal((await request('/api/health')).status, 200);
    assert.equal(
      (
        await request('/api/auth/login', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ password: 'bad' }),
        })
      ).status,
      401,
    );
    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'local-test-password-123' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    const headers = { cookie, origin, 'content-type': 'application/json' };
    assert.equal((await request('/api/state', { headers })).status, 200);
    assert.equal(
      (
        await request('/api/config', {
          method: 'POST',
          headers: { ...headers, origin: 'https://evil.invalid' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request('/api/config', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            host: '169.254.169.254',
            serial: 'TEST123456',
            accessCode: '12345678',
          }),
        })
      ).status,
      400,
    );
    const save = await request('/api/config', {
      method: 'POST',
      headers,
      body: JSON.stringify({ host: '192.168.1.20', serial: 'TEST123456', accessCode: '12345678' }),
    });
    assert.equal(save.status, 200);
    assert.equal(JSON.stringify(await save.json()).includes('12345678'), false);
    assert.equal(
      (await request('/api/auth/logout', { method: 'POST', headers, body: '{}' })).status,
      200,
    );
    assert.equal((await request('/api/state', { headers })).status, 401);
    assert.equal((await request('/.env')).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
