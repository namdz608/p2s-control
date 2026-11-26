import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import yazl from 'yazl';
import { ConfigStore } from '../server/models/printer-config.model.mjs';
import { ProjectService } from '../server/services/project.service.mjs';
import { createApp } from '../server/app.mjs';

async function slicedFile() {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('G90\n'), 'Metadata/plate_1.gcode');
  zip.addBuffer(
    Buffer.from(
      '<config><plate><metadata key="index" value="1"/><filament id="1" type="PLA" color="#FFFFFF"/></plate></config>',
    ),
    'Metadata/slice_info.config',
  );
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  zip.end();
  return done;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'p2s-download-'));
  const config = await ConfigStore.open(directory);
  const printer = { snapshot: () => ({}), event() {} };
  const projects = await ProjectService.open(directory, printer, config);
  const server = createApp({
    config,
    printer,
    projects,
    password: 'download-test-password',
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    projects.queue.cancel();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = (url, method = 'GET', body, extraHeaders = {}) =>
    fetch(`${origin}${url}`, {
      method,
      headers: {
        origin,
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'download-test-password' }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
  return { origin, request, cookie, projects };
}

test('authenticated user can download a print file as an attachment named after the project', async (t) => {
  const f = await fixture(t);
  const contents = await slicedFile();
  const form = new FormData();
  form.append('file', new Blob([contents]), 'Batman-Head.gcode.3mf');
  const created = await fetch(`${f.origin}/api/v1/projects`, {
    method: 'POST',
    headers: { origin: f.origin, cookie: f.cookie },
    body: form,
  });
  assert.equal(created.status, 201);
  const project = await created.json();

  const download = await f.request(`/api/v1/projects/${project.id}/file`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') || '', /^attachment/);
  assert.match(download.headers.get('content-disposition') || '', /Batman-Head\.gcode\.3mf/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), contents);

  assert.equal((await f.request(`/api/v1/projects/${'0'.repeat(32)}/file`)).status, 404);
  assert.equal((await f.request('/api/v1/projects/%2e%2e%2fsecret/file')).status, 404);
});

test('print file download requires login', async (t) => {
  const f = await fixture(t);
  const contents = await slicedFile();
  const form = new FormData();
  form.append('file', new Blob([contents]), 'part.gcode.3mf');
  const created = await fetch(`${f.origin}/api/v1/projects`, {
    method: 'POST',
    headers: { origin: f.origin, cookie: f.cookie },
    body: form,
  });
  const project = await created.json();
  await f.request('/api/v1/auth/logout', 'POST', {});
  assert.equal((await f.request(`/api/v1/projects/${project.id}/file`)).status, 401);
});
