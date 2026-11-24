import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Writable } from 'node:stream';
import path from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { FileType } from 'basic-ftp';
import { ConfigStore } from '../server/models/printer-config.model.mjs';
import { createApp } from '../server/app.mjs';
import { AppError } from '../server/errors/app-error.mjs';
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

test('opening a USB timelapse streams the requested mp4 bytes and refuses other files', async () => {
  const body = Buffer.from('0123456789abcdef');
  const downloaded = [];
  const ftp = async (_config, task) =>
    task({
      async list() {
        return [
          { name: 'video_2026-11-07_23-59-28.mp4', type: FileType.File, size: body.length },
          { name: 'notes.txt', type: FileType.File, size: 4 },
        ];
      },
      async downloadTo(destination, remote, startAt = 0) {
        downloaded.push([remote, startAt]);
        const rest = body.subarray(startAt);
        for (let offset = 0; offset < rest.length; offset += 4) {
          if (destination.destroyed) return;
          destination.write(rest.subarray(offset, offset + 4));
        }
        if (!destination.destroyed) destination.end();
      },
    });
  const { service: files } = service(ftp);
  await assert.rejects(files.openVideo('/timelapse/notes.txt'), /MP4/i);
  await assert.rejects(files.openVideo('/timelapse/missing.mp4'), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
  const clip = await files.openVideo('/timelapse/video_2026-11-07_23-59-28.mp4');
  assert.equal(clip.size, body.length);
  const chunks = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await files.writeVideo(clip.path, sink, 4, 4);
  assert.equal(Buffer.concat(chunks).toString(), '4567');
  assert.deepEqual(downloaded, [['timelapse/video_2026-11-07_23-59-28.mp4', 4]]);
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

test('removeMany lists each folder once and deletes the chosen files in parallel', async () => {
  let active = 0;
  let peak = 0;
  const lists = [];
  const removed = [];
  const ftp = async (_config, task) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      return await task({
        async list(directory) {
          lists.push(directory);
          return [
            { name: 'a.gcode.3mf', type: FileType.File, size: 1 },
            { name: 'bad.gcode.3mf', type: FileType.File, size: 1 },
            { name: 'keep.gcode.3mf', type: FileType.File, size: 1 },
            { name: 'cache', type: FileType.Directory, size: 0 },
          ];
        },
        async remove(file) {
          removed.push(file);
          if (file === 'bad.gcode.3mf') throw new AppError('USB từ chối tệp này.');
          await new Promise((resolve) => setTimeout(resolve, 40));
        },
      });
    } finally {
      active -= 1;
    }
  };
  const { service: files, events } = service(ftp);
  await assert.rejects(files.removeMany(['/a.gcode.3mf'], false), /xác nhận/i);
  const result = await files.removeMany(
    ['/a.gcode.3mf', '/bad.gcode.3mf', '/cache', '/missing.gcode.3mf', '/a.gcode.3mf'],
    true,
  );
  assert.deepEqual(lists, ['']);
  assert.deepEqual(result.removed, ['/a.gcode.3mf']);
  assert.deepEqual(
    result.failed.map((item) => item.path),
    ['/cache', '/missing.gcode.3mf', '/bad.gcode.3mf'],
  );
  assert.match(result.failed.find((item) => item.path === '/bad.gcode.3mf').error, /từ chối/i);
  assert.equal(peak > 1, true);
  assert.deepEqual(removed, ['a.gcode.3mf', 'bad.gcode.3mf']);
  assert.deepEqual(events, ['Đã xóa tệp trên USB: a.gcode.3mf']);
  await assert.rejects(files.removeMany([], true), /ít nhất một tệp/i);
  await assert.rejects(
    service(ftp, { jobPending: true }).service.removeMany(['/a.gcode.3mf'], true),
    /đang gửi/i,
  );
  const busy = await service(ftp, { status: 'RUNNING', task: 'keep.gcode.3mf' }).service.removeMany(
    ['/keep.gcode.3mf', '/a.gcode.3mf'],
    true,
  );
  assert.deepEqual(busy.removed, ['/a.gcode.3mf']);
  assert.match(busy.failed[0].error, /bản in/i);
});

test('removing a library copy deletes that project file, ignores a missing one, and refuses an active print', async () => {
  const id = 'a'.repeat(32);
  const removed = [];
  const ftp = async (_config, task) =>
    task({
      async list() {
        return [{ name: `${id}.gcode.3mf`, type: FileType.File, size: 4 }];
      },
      async remove(file) {
        removed.push(file);
      },
    });
  assert.deepEqual(await service(ftp).service.removeOwnedCopy(id), {
    removed: true,
    reason: 'removed',
  });
  assert.deepEqual(removed, [`${id}.gcode.3mf`]);
  const missing = service(async (_config, task) =>
    task({
      async list() {
        return [];
      },
      async remove() {
        throw new Error('should not remove');
      },
    }),
  );
  assert.deepEqual(await missing.service.removeOwnedCopy(id), {
    removed: false,
    reason: 'absent',
  });
  const unconfigured = new PrinterStorageService(
    { get: () => ({}) },
    { jobPending: false, snapshot: () => ({ status: 'IDLE' }), raw: { print: {} }, event() {} },
  );
  assert.deepEqual(await unconfigured.removeOwnedCopy(id), {
    removed: false,
    reason: 'unconfigured',
  });
  await assert.rejects(
    service(ftp, { status: 'RUNNING', task: `${id}.gcode.3mf` }).service.removeOwnedCopy(id),
    /bản in/i,
  );
  assert.deepEqual(removed, [`${id}.gcode.3mf`]);
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
    removeMany: async (paths, confirmed) => {
      seen.push(['removeMany', paths, confirmed]);
      return { ok: true, removed: paths, failed: [] };
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
    const many = await fetch(`${origin}/api/v1/printer/storage`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ paths: ['/a.gcode.3mf', '/b.gcode.3mf'], confirmed: true }),
    });
    assert.equal(many.status, 200);
    assert.deepEqual(seen, [
      ['list', '/cache'],
      ['remove', '/cache/old.gcode.3mf', true],
      ['removeMany', ['/a.gcode.3mf', '/b.gcode.3mf'], true],
    ]);
    const page = await readFile(new URL('../server/views/index.html', import.meta.url), 'utf8');
    const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(page, /data-page="usb"/);
    assert.match(page, /id="page-usb"/);
    assert.match(page, /id="usb-refresh"/);
    assert.match(page, /id="usb-select-all"/);
    assert.match(page, /id="usb-delete-selected"/);
    assert.match(page, /id="usb-capacity"/);
    assert.equal(
      page.includes('id="page-files"') && page.split('id="page-usb"')[0].includes('id="usb-list"'),
      false,
    );
    assert.match(app, /usb: \['USB'/);
    assert.match(app, /data-usb-select/);
    assert.match(app, /\/printer\/storage/);
    assert.match(app, /confirmed: true/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('usb select boxes delete only the chosen files and skip a file the printer is using', async () => {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        textContent: '',
        innerHTML: '',
        hidden: false,
        disabled: false,
        checked: false,
        indeterminate: false,
        classList: { toggle() {} },
        addEventListener() {},
        setAttribute() {},
        className: '',
      });
    return nodes.get(selector);
  };
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll: () => [] },
    setTimeout,
    clearTimeout,
    calls: [],
  });
  vm.runInContext(source.slice(0, source.indexOf("$('#today')")), context);
  context.api = async (url, options) => {
    context.calls.push({ url, options });
    if (String(url).startsWith('/printer/storage?'))
      return {
        path: '/',
        parent: null,
        entries: [
          {
            type: 'file',
            name: 'keep.gcode.3mf',
            path: '/keep.gcode.3mf',
            label: 'Giữ lại',
            size: 4,
          },
          {
            type: 'file',
            name: 'bad.gcode.3mf',
            path: '/bad.gcode.3mf',
            label: 'Tệp lỗi',
            size: 12,
          },
        ],
        truncated: false,
      };
    if (options?.method === 'DELETE') {
      const paths = options.body?.paths || [];
      return {
        ok: !paths.includes('/bad.gcode.3mf'),
        removed: paths.filter((item) => item !== '/bad.gcode.3mf'),
        failed: paths.includes('/bad.gcode.3mf')
          ? [{ path: '/bad.gcode.3mf', error: 'USB từ chối tệp này.' }]
          : [],
      };
    }
    return { ok: true };
  };
  vm.runInContext('confirmAction = async () => false;', context);
  vm.runInContext(
    `UI.printer = { status: 'RUNNING', jobPending: false, task: 'Đang in', activeFile: 'busy.gcode.3mf', sdcard: true };
     UI.usb = { path: '/', parent: null, entries: [
       { type: 'directory', name: 'ipcam', path: '/ipcam' },
       { type: 'file', name: 'busy.gcode.3mf', path: '/busy.gcode.3mf', label: 'Đang in', size: 8 },
       { type: 'file', name: 'a.gcode.3mf', path: '/a.gcode.3mf', label: 'Tệp A', size: 10 },
       { type: 'file', name: 'bad.gcode.3mf', path: '/bad.gcode.3mf', label: 'Tệp lỗi', size: 12 },
     ], truncated: false, loaded: true };
     UI.usbSelected = [];
     renderUsb();`,
    context,
  );
  const list = node('#usb-list').innerHTML;
  assert.match(node('#usb-capacity').textContent, /Chưa đọc được dung lượng/);
  vm.runInContext(
    'UI.printer.usbSpace = { totalBytes: 1024 ** 3, freeBytes: 512 * 1024 * 1024 }; renderUsb();',
    context,
  );
  assert.equal(node('#usb-capacity').textContent, 'Còn 512.0 MB / 1.00 GB.');
  assert.match(list, /data-usb-open="%2Fipcam"/);
  assert.doesNotMatch(list, /data-usb-select="%2Fipcam"/);
  assert.match(list, /data-usb-select="%2Fa\.gcode\.3mf"/);
  assert.match(list, /data-usb-select="%2Fbusy\.gcode\.3mf"[^>]*disabled/);
  vm.runInContext('toggleUsbSelectAll(true);', context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(UI.usbSelected)', context)), [
    '/a.gcode.3mf',
    '/bad.gcode.3mf',
  ]);
  assert.equal(node('#usb-delete-selected').disabled, false);
  assert.match(node('#usb-delete-selected').textContent, /2/);
  await vm.runInContext('deleteUsbSelected()', context);
  assert.equal(context.calls.length, 0);
  vm.runInContext('confirmAction = async () => true;', context);
  await vm.runInContext('deleteUsbSelected()', context);
  const deleted = context.calls.filter((call) => call.options?.method === 'DELETE');
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].options.body.confirmed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(deleted[0].options.body.paths)), [
    '/a.gcode.3mf',
    '/bad.gcode.3mf',
  ]);
  assert.match(node('#usb-error').textContent, /USB từ chối tệp này/);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(UI.usbSelected)', context)), [
    '/bad.gcode.3mf',
  ]);
  vm.runInContext(
    `UI.usb.entries = [
      { type: 'file', name: 'video_2026-11-07_23-59-28.mp4', path: '/timelapse/video_2026-11-07_23-59-28.mp4', size: 5300000 },
      { type: 'file', name: 'a.gcode.3mf', path: '/a.gcode.3mf', label: 'Tệp A', size: 10 },
    ];
    renderUsb();`,
    context,
  );
  const videos = node('#usb-list').innerHTML;
  assert.match(videos, /data-usb-play="%2Ftimelapse%2Fvideo_2026-11-07_23-59-28\.mp4"/);
  assert.match(videos, />Xem</);
  assert.match(videos, /Bấm để xem/);
  assert.doesNotMatch(videos, /data-usb-play="%2Fa\.gcode\.3mf"/);
});

test('usb video route requires login and plays an mp4 range inline', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'p2s-usb-video-'));
  const config = await ConfigStore.open(directory);
  const body = Buffer.from('01234567');
  const storage = {
    openVideo: async (filePath) => {
      if (!String(filePath).toLowerCase().endsWith('.mp4'))
        throw new AppError('Chỉ mở được tệp video MP4.', 400);
      return { path: filePath, name: 'video_2026-11-07_23-59-28.mp4', size: body.length };
    },
    writeVideo: async (_filePath, destination, start, length) => {
      destination.end(body.subarray(start, start + length));
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
    assert.equal(
      (await fetch(`${origin}/api/v1/printer/storage/video?path=%2Ftimelapse%2Fvideo.mp4`)).status,
      401,
    );
    const login = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'local-test-password-123' }),
    });
    const headers = { origin, cookie: login.headers.get('set-cookie').split(';')[0] };
    const denied = await fetch(`${origin}/api/v1/printer/storage/video?path=%2Fnotes.txt`, {
      headers,
    });
    assert.equal(denied.status, 400);
    const video = await fetch(
      `${origin}/api/v1/printer/storage/video?path=%2Ftimelapse%2Fvideo.mp4`,
      { headers: { ...headers, range: 'bytes=0-3' } },
    );
    assert.equal(video.status, 206);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    assert.equal(video.headers.get('cache-control'), 'private');
    assert.equal(video.headers.get('accept-ranges'), 'bytes');
    assert.match(video.headers.get('content-disposition'), /^inline;/);
    assert.equal(await video.text(), '0123');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
