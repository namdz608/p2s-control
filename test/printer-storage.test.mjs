import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FileType } from 'basic-ftp';
import { ConfigStore } from '../server/models/printer-config.model.mjs';
import { createApp } from '../server/app.mjs';
import {
  attachStorageLabels,
  describeStorageEntry,
  ftpPath,
  PrinterStorageService,
  resolveStoragePath,
} from '../server/services/printer-storage.service.mjs';

test('storage paths stay inside the printer USB root', () => {
  assert.equal(resolveStoragePath('/'), '/');
  assert.equal(resolveStoragePath(' /cache/job.gcode.3mf '), '/cache/job.gcode.3mf');
  assert.equal(ftpPath('/'), '');
  assert.equal(ftpPath('/cache/job.gcode.3mf'), 'cache/job.gcode.3mf');
  for (const input of [
    '../etc',
    '/cache/../../etc',
    '/./secret',
    'cache',
    '\\cache',
    '/cache/',
    '',
  ])
    assert.throws(() => resolveStoragePath(input), /không hợp lệ/i);
});

test('known print archives show the library name beside the USB file', () => {
  const [named, plain] = attachStorageLabels(
    [
      { name: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.gcode.3mf', type: 'file' },
      { name: 'notes.txt', type: 'file' },
    ],
    [{ id: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', name: '03-Khuon-mat-DA-AMS3' }],
  );
  assert.equal(named.label, '03-Khuon-mat-DA-AMS3');
  assert.equal(plain.label, undefined);
});

test('storage listing keeps files and directories and drops navigation entries', () => {
  assert.equal(describeStorageEntry('/', { name: '..', type: FileType.Directory }), null);
  assert.equal(describeStorageEntry('/', { name: 'a/b', type: FileType.File }), null);
  assert.deepEqual(
    describeStorageEntry('/cache', {
      name: 'job.gcode.3mf',
      type: FileType.File,
      size: 42,
      modifiedAt: new Date('2026-11-08T00:00:00Z'),
    }),
    {
      name: 'job.gcode.3mf',
      path: '/cache/job.gcode.3mf',
      type: 'file',
      size: 42,
      modifiedAt: '2026-11-08T00:00:00.000Z',
    },
  );
});

function service(ftp, { status = 'IDLE', jobPending = false, gcodeFile = '', task = '' } = {}) {
  const events = [];
  const printer = {
    jobPending,
    raw: { print: { gcode_file: gcodeFile, subtask_name: task } },
    snapshot: () => ({ status, task }),
    event(message) {
      events.push(message);
    },
  };
  const config = { get: () => ({ host: '10.0.0.8', accessCode: 'secret-code' }) };
  return { service: new PrinterStorageService(config, printer, ftp), events };
}

test('listing reads the USB directory and hides the access code when FTPS fails', async () => {
  const calls = [];
  const { service: files } = service(async (config, task) => {
    calls.push(config.accessCode);
    return task({
      async list(directory) {
        calls.push(directory);
        return [
          { name: '.', type: FileType.Directory, size: 0 },
          { name: 'cache', type: FileType.Directory, size: 0 },
          { name: 'b.gcode.3mf', type: FileType.File, size: 20 },
          { name: 'a.gcode.3mf', type: FileType.File, size: 10 },
          { name: 'link', type: FileType.SymbolicLink, size: 0 },
        ];
      },
    });
  });
  const listing = await files.list('/');
  assert.equal(calls[1], '');
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ['cache', 'a.gcode.3mf', 'b.gcode.3mf', 'link'],
  );
  assert.equal(listing.entries[0].type, 'directory');
  assert.equal(listing.parent, null);
  const broken = service(async () => {
    throw new Error('530 secret-code');
  });
  await assert.rejects(broken.service.list('/'), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.message.includes('secret-code'), false);
    return true;
  });
});

test('delete removes one confirmed file and refuses directories, missing files, and an active print', async () => {
  const removed = [];
  const ftp = async (_config, task) =>
    task({
      async list() {
        return [
          { name: 'keep.gcode.3mf', type: FileType.File, size: 4 },
          { name: 'IndexerVolumeGuid', type: FileType.File, size: 76 },
          { name: 'cache', type: FileType.Directory, size: 0 },
        ];
      },
      async remove(file) {
        removed.push(file);
      },
    });
  const idle = service(ftp);
  await assert.rejects(idle.service.remove('/keep.gcode.3mf', false), /xác nhận/i);
  assert.deepEqual(await idle.service.remove('/keep.gcode.3mf', true), {
    ok: true,
    path: '/keep.gcode.3mf',
  });
  assert.deepEqual(removed, ['keep.gcode.3mf']);
  assert.match(idle.events[0], /keep\.gcode\.3mf/);
  await assert.rejects(service(ftp).service.remove('/cache', true), /thư mục/i);
  await assert.rejects(service(ftp).service.remove('/missing.gcode.3mf', true), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
  await assert.rejects(
    service(ftp, {
      status: 'RUNNING',
      gcodeFile: '/data/Metadata/plate_1.gcode',
      task: 'keep.gcode.3mf',
    }).service.remove('/keep.gcode.3mf', true),
    /bản in/i,
  );
  assert.deepEqual(
    await service(ftp, {
      status: 'RUNNING',
      gcodeFile: '/data/Metadata/plate_1.gcode',
      task: '02-Ao-choang-gang-ung-DEN-AMS2',
    }).service.remove('/IndexerVolumeGuid', true),
    { ok: true, path: '/IndexerVolumeGuid' },
  );
  await assert.rejects(
    service(ftp, { jobPending: true }).service.remove('/keep.gcode.3mf', true),
    /đang gửi/i,
  );
  assert.deepEqual(removed, ['keep.gcode.3mf', 'IndexerVolumeGuid']);
});

test('printer storage routes require login and delete only through the storage service', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'p2s-usb-'));
  const config = await ConfigStore.open(directory);
  const seen = [];
  const storage = {
    list: async (filePath) => {
      seen.push(['list', filePath]);
      return { path: '/', parent: null, entries: [], truncated: false };
    },
    remove: async (filePath, confirmed) => {
      seen.push(['remove', filePath, confirmed]);
      return { ok: true, path: filePath };
    },
  };
  const server = createApp({
    config,
    printer: {
      events: [],
      snapshot: () => ({ connection: 'unconfigured' }),
      close: async () => {},
      start: async () => {},
      command: async () => {},
    },
    projects: { queue: { snapshot: () => ({}) }, list: async () => [] },
    camera: {},
    storage,
    password: 'local-test-password-123',
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/api/v1/printer/storage`)).status, 401);
    const login = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'local-test-password-123' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { origin, cookie, 'content-type': 'application/json' };
    const listing = await fetch(`${origin}/api/v1/printer/storage?path=%2Fcache`, { headers });
    assert.equal(listing.status, 200);
    assert.equal((await listing.json()).path, '/');
    const removed = await fetch(`${origin}/api/v1/printer/storage`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ path: '/cache/old.gcode.3mf', confirmed: true }),
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(seen, [
      ['list', '/cache'],
      ['remove', '/cache/old.gcode.3mf', true],
    ]);
    const page = await readFile(new URL('../server/views/index.html', import.meta.url), 'utf8');
    const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(page, /data-page="usb"/);
    assert.match(page, /id="page-usb"/);
    assert.match(page, /id="usb-refresh"/);
    assert.equal(
      page.includes('id="page-files"') && page.split('id="page-usb"')[0].includes('id="usb-list"'),
      false,
    );
    assert.match(app, /usb: \['USB'/);
    assert.match(app, /\/printer\/storage/);
    assert.match(app, /confirmed: true/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
