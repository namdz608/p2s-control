import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../server/models/printer-config.model.mjs';
import { createApp } from '../server/app.mjs';

test('versioned resource routes preserve authentication, response contracts and legacy URLs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'p2s-api-v1-'));
  const config = await ConfigStore.open(directory);
  const commands = [];
  const starts = [];
  let connections = 0;
  let releasedCameras = 0;
  let diagnosticChecks = 0;
  const printer = {
    jobPending: false,
    configPending: false,
    events: [],
    snapshot: () => ({ connection: 'unconfigured', fresh: false }),
    close: async () => {},
    start: async () => {
      connections++;
    },
    command: async (input) => {
      commands.push(input);
    },
    refreshStatus: async () => {
      diagnosticChecks++;
    },
    event() {},
  };
  const queueCalls = [];
  const queueState = { status: 'idle', active: false, items: [] };
  const projects = {
    queue: {
      snapshot: () => queueState,
      start: async (input) => {
        queueCalls.push(input);
        return { ...queueState, status: 'submitting', active: true };
      },
      cancel: () => ({ ...queueState, status: 'cancelled' }),
    },
    list: async () => [{ id: 'sample', name: 'Sample' }],
    remove: async (id) => {
      assert.equal(id, 'sample');
    },
    start: async (id, input) => {
      starts.push({ id, input });
    },
  };
  const camera = {
    open: async () => ({
      response: new Response(new Uint8Array([255, 216, 255, 217]), {
        headers: { 'content-type': 'image/jpeg' },
      }),
      release() {
        releasedCameras++;
      },
    }),
  };
  const server = createApp({
    config,
    printer,
    projects,
    camera,
    password: 'local-test-password-123',
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = (url, method = 'GET', body, extraHeaders) =>
    fetch(origin + url, {
      method,
      headers: { origin, cookie, 'content-type': 'application/json', ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await request('/api/v1/health')).status, 200);
    assert.deepEqual(await (await request('/api/v1/auth/session')).json(), {
      authenticated: false,
    });
    for (const url of [
      '/api/v1/printer',
      '/api/v1/printer/config',
      '/api/v1/projects',
      '/api/v1/projects/queue',
      '/api/v1/camera/snapshot',
      '/api/v1/printer/storage',
      '/api/state',
    ]) {
      assert.equal((await request(url)).status, 401, url);
    }
    assert.equal((await request('/api/v1/printer/diagnostics', 'POST', {})).status, 401);
    const login = await request('/api/v1/auth/login', 'POST', {
      password: 'local-test-password-123',
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    assert.deepEqual(await (await request('/api/v1/auth/session')).json(), { authenticated: true });
    assert.deepEqual(
      await (await request('/api/v1/printer')).json(),
      await (await request('/api/state')).json(),
    );
    const saved = await request('/api/v1/printer/config', 'PUT', {
      name: 'P2S',
      host: '192.168.1.20',
      serial: 'TEST123456789',
      accessCode: 'test1234',
    });
    assert.equal(saved.status, 200);
    assert.equal(JSON.stringify(await saved.json()).includes('test1234'), false);
    assert.equal(connections, 1);
    assert.deepEqual(
      await (await request('/api/v1/printer/config')).json(),
      await (await request('/api/config')).json(),
    );
    assert.equal(
      (await request('/api/v1/printer/config', 'PUT', {}, { origin: 'https://evil.invalid' }))
        .status,
      403,
    );
    assert.equal((await request('/api/v1/printer/commands', 'POST', { type: 'stop' })).status, 400);
    assert.equal(
      (await request('/api/v1/printer/commands', 'POST', { type: 'light', value: true })).status,
      202,
    );
    assert.deepEqual(commands, [{ type: 'light', value: true }]);
    assert.equal((await request('/api/v1/printer/reconnect', 'POST', {})).status, 200);
    assert.equal(connections, 2);
    assert.equal(
      (await request('/api/v1/printer/diagnostics', 'POST', {}, { origin: 'https://evil.invalid' }))
        .status,
      403,
    );
    const diagnosis = await request('/api/v1/printer/diagnostics', 'POST', {});
    assert.equal(diagnosis.status, 200);
    assert.equal((await diagnosis.json()).lastCheck.received, true);
    assert.equal(diagnosticChecks, 1);
    assert.deepEqual(await (await request('/api/v1/projects')).json(), await projects.list());
    assert.deepEqual(await (await request('/api/v1/projects/queue')).json(), queueState);
    const queued = await request('/api/v1/projects/queue/start', 'POST', { confirmed: true });
    assert.equal(queued.status, 202);
    assert.equal((await queued.json()).active, true);
    assert.deepEqual(queueCalls, [{ confirmed: true }]);
    assert.equal(
      (
        await request(
          '/api/v1/projects/queue/start',
          'POST',
          { confirmed: true },
          { origin: 'https://evil.invalid' },
        )
      ).status,
      403,
    );
    assert.equal(queueCalls.length, 1);
    assert.equal(
      (await (await request('/api/v1/projects/queue/cancel', 'POST', {})).json()).status,
      'cancelled',
    );
    assert.equal(
      (await request('/api/v1/projects/sample/start', 'POST', { plate: 1, confirmed: true }))
        .status,
      202,
    );
    assert.deepEqual(starts, [{ id: 'sample', input: { plate: 1, confirmed: true } }]);
    assert.equal((await request('/api/v1/projects/sample', 'DELETE')).status, 200);
    const snapshot = await request('/api/v1/camera/snapshot');
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await snapshot.arrayBuffer())], [255, 216, 255, 217]);
    assert.equal(releasedCameras, 1);
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Printroom/);
    assert.equal((await request('/api/v1/auth/logout', 'POST', {})).status, 200);
    assert.equal((await request('/api/v1/printer')).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
