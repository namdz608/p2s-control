import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../server/models/printer-config.model.mjs';
import { ProjectService } from '../server/services/project.service.mjs';
import { ProjectModel } from '../server/models/project.model.mjs';
import { createApp } from '../server/app.mjs';
import yazl from 'yazl';

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

async function upload(f, contents, folderId, fieldFirst = false) {
  const form = new FormData();
  if (fieldFirst && folderId !== undefined) form.append('folderId', folderId);
  form.append('file', new Blob([contents]), 'part.gcode.3mf');
  if (!fieldFirst && folderId !== undefined) form.append('folderId', folderId);
  return fetch(`${f.origin}/api/v1/projects`, {
    method: 'POST',
    headers: { origin: f.origin, cookie: f.cookie },
    body: form,
  });
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'p2s-folders-'));
  const config = await ConfigStore.open(directory);
  const printer = { snapshot: () => ({}), event() {} };
  const projects = await ProjectService.open(directory, printer, config);
  const server = createApp({ config, printer, projects, password: 'folder-test-password' }).listen(
    0,
    '127.0.0.1',
  );
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    projects.queue.cancel();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = (url, method = 'GET', body, extraHeaders = {}) =>
    fetch(`${origin}/api/v1/projects${url}`, {
      method,
      headers: { origin, cookie, 'content-type': 'application/json', ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'folder-test-password' }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
  return { directory, config, printer, projects, origin, request, cookie };
}

test('folders can be created, listed and reopened after a restart', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/folders', 'POST', { name: '  Batman  ' });
  assert.equal(response.status, 201);
  const folder = await response.json();
  assert.match(folder.id, /^[a-f0-9]{32}$/);
  assert.equal(folder.name, 'Batman');
  assert.deepEqual(await (await f.request('/folders')).json(), [folder]);
  const reopened = await ProjectService.open(f.directory, f.printer, f.config);
  assert.deepEqual(await reopened.listFolders(), [folder]);
});

test('folder creation validates names, prevents duplicates and requires a same-origin login', async (t) => {
  const f = await fixture(t);
  for (const name of [
    undefined,
    null,
    123,
    '',
    '   ',
    '.',
    '..',
    '../secret',
    'a\\b',
    'a\u0000b',
    'x'.repeat(81),
  ]) {
    assert.equal((await f.request('/folders', 'POST', { name })).status, 400, String(name));
  }
  assert.equal(
    (await f.request('/folders', 'POST', { name: 'Parts', parentId: 'nested' })).status,
    400,
  );
  assert.equal(
    (await f.request('/folders', 'POST', { name: 'Parts' }, { cookie: '' })).status,
    401,
  );
  assert.equal((await f.request('/folders')).status, 200);
  assert.equal((await f.request('/folders', 'GET', undefined, { cookie: '' })).status, 401);
  assert.equal(
    (await f.request('/folders', 'POST', { name: 'Parts' }, { origin: 'https://evil.invalid' }))
      .status,
    403,
  );
  const responses = await Promise.all([
    f.request('/folders', 'POST', { name: 'Parts' }),
    f.request('/folders', 'POST', { name: '  PARTS  ' }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal((await (await f.request('/folders')).json()).length, 1);
});

test('uploads target a folder and files can move between folders and the root without losing data', async (t) => {
  const f = await fixture(t);
  const first = await (await f.request('/folders', 'POST', { name: 'Batman' })).json();
  const second = await (await f.request('/folders', 'POST', { name: 'Parts' })).json();
  const contents = await slicedFile();
  const uploaded = await upload(f, contents, first.id);
  assert.equal(uploaded.status, 201);
  const project = await uploaded.json();
  assert.equal(project.folderId, first.id);
  const moved = await f.request(`/${project.id}/folder`, 'PATCH', { folderId: second.id });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).folderId, second.id);
  assert.deepEqual(
    await readFile(path.join(f.directory, 'projects', `${project.id}.gcode.3mf`)),
    contents,
  );
  const reopened = await ProjectService.open(f.directory, f.printer, f.config);
  assert.equal((await reopened.list())[0].folderId, second.id);
  assert.equal((await f.request(`/${project.id}/folder`, 'PATCH', { folderId: null })).status, 200);
  const rooted = (await (await f.request('')).json())[0];
  assert.deepEqual(rooted, { ...project, folderId: null });
  assert.equal((await upload(f, contents)).status, 201, 'legacy uploads still land in the root');
  const beforeFile = await upload(f, contents, second.id, true);
  assert.equal(beforeFile.status, 201, 'multipart field order must not matter');
  assert.equal((await beforeFile.json()).folderId, second.id);
});

test('invalid destinations leave existing files intact and clean up rejected uploads', async (t) => {
  const f = await fixture(t);
  const contents = await slicedFile();
  const project = await (await upload(f, contents)).json();
  for (const folderId of ['a'.repeat(32), '../projects', {}, false]) {
    assert.equal((await f.request(`/${project.id}/folder`, 'PATCH', { folderId })).status, 404);
  }
  assert.equal((await f.request(`/${project.id}/folder`, 'PATCH', {})).status, 400);
  assert.equal(
    (await f.request(`/${project.id}/folder`, 'PATCH', { folderId: null }, { cookie: '' })).status,
    401,
  );
  assert.equal(
    (
      await f.request(
        `/${project.id}/folder`,
        'PATCH',
        { folderId: null },
        { origin: 'https://evil.invalid' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.request(`/${'b'.repeat(32)}/folder`, 'PATCH', { folderId: null })).status,
    404,
  );
  const rejected = await upload(f, contents, 'a'.repeat(32));
  assert.equal(rejected.status, 404);
  assert.deepEqual(await readdir(path.join(f.directory, 'uploads')), []);
  assert.deepEqual(await (await f.request('')).json(), [project]);
});

test('files saved before folders existed stay readable and can be moved into a new folder', async (t) => {
  const f = await fixture(t);
  const project = { id: 'c'.repeat(32), name: 'Legacy', plates: [], addedAt: '2026-11-08' };
  await writeFile(
    path.join(f.directory, 'projects', `${project.id}.json`),
    JSON.stringify(project),
  );
  assert.deepEqual(await (await f.request('')).json(), [project]);
  const folder = await (await f.request('/folders', 'POST', { name: 'Old files' })).json();
  const response = await f.request(`/${project.id}/folder`, 'PATCH', { folderId: folder.id });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...project, folderId: folder.id });
});

test('moving and deleting the same file concurrently never resurrects deleted metadata', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'p2s-move-delete-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const model = await ProjectModel.open(directory);
  const id = 'a'.repeat(32);
  for (let attempt = 0; attempt < 10; attempt++) {
    await writeFile(model.file(id, 'json'), JSON.stringify({ id, name: 'Part' }));
    await writeFile(model.file(id, 'gcode.3mf'), 'sample');
    await Promise.allSettled(
      attempt % 2
        ? [model.remove(id), model.move(id, 'b'.repeat(32))]
        : [model.move(id, 'b'.repeat(32)), model.remove(id)],
    );
    assert.equal((await model.list()).length, 0, 'a deleted file must not reappear in the library');
    await assert.rejects(readFile(model.file(id, 'gcode.3mf')), { code: 'ENOENT' });
  }
});
