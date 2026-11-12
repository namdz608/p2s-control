import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { AppError } from '../server/errors/app-error.mjs';
import { inspectArchive, readPlatePreview } from '../server/services/project-archive.service.mjs';
import { buildPrintRequest } from '../server/services/print-request.service.mjs';
import { ProjectService } from '../server/services/project.service.mjs';

async function archive(file, metadata) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('G90\n'), 'Metadata/plate_8.gcode');
  zip.addBuffer(Buffer.from(metadata), 'Metadata/slice_info.config');
  const done = new Promise((resolve, reject) =>
    zip.outputStream.pipe(createWriteStream(file)).on('finish', resolve).on('error', reject),
  );
  zip.end();
  await done;
}
const metadata =
  '<config><plate><metadata key="index" value="8"/><metadata key="filament_maps" value="1 1 1 1"/><metadata key="prediction" value="3600"/><filament id="4" type="PLA" color="#FF8800" used_g="12.4"/></plate></config>';

test('print request rejects black PLA for a gray file and maps gray filament 4 to tray A4', () => {
  const project = {
    id: 'gray',
    name: '04-Gray-AMS4',
    plates: [
      { number: 1, filamentCount: 4, filaments: [{ id: 4, type: 'PLA', color: '#808080' }] },
    ],
  };
  const state = {
    status: 'IDLE',
    sdcard: true,
    printError: 0,
    ams: [
      {
        id: '0',
        trays: [
          { id: '1', type: 'PLA', color: '#000000' },
          { id: '3', type: 'PLA', color: '#808080' },
        ],
      },
    ],
  };
  assert.throws(
    () =>
      buildPrintRequest(
        project,
        { plate: 1, useAms: true, mapping: [-1, -1, -1, 1], confirmed: true },
        state,
      ),
    /màu/i,
  );
  const result = buildPrintRequest(
    project,
    { plate: 1, useAms: true, mapping: [-1, -1, -1, 3], confirmed: true },
    state,
  );
  assert.deepEqual(result.print.ams_mapping, [-1, -1, -1, 3]);
});

test('a reported printer error does not block sending a ready print', () => {
  const project = {
    id: 'ready',
    name: 'ready',
    plates: [
      { number: 1, filamentCount: 1, filaments: [{ id: 1, type: 'PLA', color: '#FFFFFF' }] },
    ],
  };
  const request = buildPrintRequest(
    project,
    { plate: 1, useAms: false, confirmed: true },
    { status: 'IDLE', sdcard: true, printError: 50348044, ams: [] },
  );
  assert.equal(request.print.command, 'project_file');
});

test('manual individual print honors A2 even when file name says AMS4 and reported color differs', () => {
  const project = {
    id: 'gray',
    name: 'gray-AMS4',
    plates: [
      { number: 1, filamentCount: 4, filaments: [{ id: 4, type: 'PLA', color: '#808080' }] },
    ],
  };
  const state = {
    status: 'IDLE',
    sdcard: true,
    printError: 0,
    ams: [{ id: '0', trays: [{ id: '1', type: 'PLA', color: '#000000' }] }],
  };
  const input = {
    plate: 1,
    useAms: true,
    mapping: [-1, -1, -1, 1],
    mappingMode: 'manual',
    confirmed: true,
  };
  assert.deepEqual(buildPrintRequest(project, input, state).print.ams_mapping, [-1, -1, -1, 1]);
  assert.throws(() => buildPrintRequest(project, { ...input, mappingMode: 'auto' }, state), /màu/);
  assert.throws(
    () =>
      buildPrintRequest(project, input, {
        ...state,
        ams: [{ id: '0', trays: [{ id: '1', type: 'PETG', color: '#808080' }] }],
      }),
    /cần PLA/,
  );
  assert.deepEqual(
    buildPrintRequest(project, input, {
      ...state,
      ams: [{ id: '0', trays: [{ id: '1', type: '', color: '#808080' }] }],
    }).print.ams_mapping,
    [-1, -1, -1, 1],
  );
  assert.throws(
    () => buildPrintRequest(project, input, { ...state, ams: [{ id: '0', trays: [] }] }),
    /khay/i,
  );
  assert.throws(
    () => buildPrintRequest(project, { ...input, mappingMode: 'invalid' }, state),
    /chọn khay/i,
  );
});

test('manual mode accepts every reported AMS slot even when only A2 has declared material; auto still refuses unknown material', () => {
  const project = {
    id: 'black',
    name: '02-Black-AMS2',
    plates: [
      { number: 1, filamentCount: 4, filaments: [{ id: 2, type: 'PLA', color: '#000000' }] },
    ],
  };
  const state = {
    status: 'IDLE',
    sdcard: true,
    printError: 0,
    ams: [
      {
        id: '0',
        trays: [0, 1, 2, 3].map((id) => ({
          id: String(id),
          type: id === 1 ? 'PLA' : '',
          color: id === 1 ? '#F72323' : '#70777d',
        })),
      },
    ],
  };
  for (const slot of [0, 1, 2, 3]) {
    const mapping = [-1, slot, -1, -1];
    const input = { plate: 1, useAms: true, mappingMode: 'manual', mapping, confirmed: true };
    assert.deepEqual(buildPrintRequest(project, input, state).print.ams_mapping, mapping);
    if (slot !== 1)
      assert.throws(
        () => buildPrintRequest(project, { ...input, mappingMode: 'auto' }, state),
        /có vật liệu/,
      );
  }
});

test('plate preview prefers the full PNG of the first plate and rejects a fake image', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-preview-'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  try {
    const file = path.join(dir, 'preview.gcode.3mf');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('not-an-image'), 'Metadata/plate_1.png');
    const done = new Promise((resolve, reject) =>
      zip.outputStream.pipe(createWriteStream(file)).on('finish', resolve).on('error', reject),
    );
    zip.end();
    await done;
    const fake = await readPlatePreview(file);
    assert.equal(fake, null);
    const real = path.join(dir, 'real.gcode.3mf');
    const second = new yazl.ZipFile();
    second.addBuffer(Buffer.from('not-an-image'), 'Metadata/plate_1.png');
    second.addBuffer(png, 'Metadata/plate_8.png');
    second.addBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'Metadata/plate_1_small.png');
    const written = new Promise((resolve, reject) =>
      second.outputStream.pipe(createWriteStream(real)).on('finish', resolve).on('error', reject),
    );
    second.end();
    await written;
    const image = await readPlatePreview(real);
    assert.equal(image.type, 'image/png');
    assert.equal(image.body.equals(png), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('3MF inspection uses whole project filament count, rejects fake archives and validates AMS mapping before printing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-3mf-'));
  try {
    const file = path.join(dir, 'sample.gcode.3mf');
    await archive(file, metadata);
    const project = {
      id: '01234567890123456789012345678901',
      name: 'Sample',
      ...(await inspectArchive(file)),
    };
    assert.equal(project.plates[0].number, 8);
    assert.equal(project.plates[0].filamentCount, 4);
    const state = {
      status: 'IDLE',
      sdcard: true,
      printError: 0,
      ams: [{ id: '0', trays: [{ id: '0', type: 'PLA' }] }],
    };
    const request = buildPrintRequest(
      project,
      { plate: 8, useAms: true, mapping: [-1, -1, -1, 0], confirmed: true },
      state,
    );
    assert.deepEqual(request.print.ams_mapping, [-1, -1, -1, 0]);
    assert.equal(request.print.param, 'Metadata/plate_8.gcode');
    assert.throws(() =>
      buildPrintRequest(project, { plate: 8, useAms: true, mapping: [0], confirmed: true }, state),
    );
    assert.throws(() =>
      buildPrintRequest(
        project,
        { plate: 8, useAms: false, confirmed: true },
        { ...state, status: 'RUNNING' },
      ),
    );
    assert.throws(() =>
      buildPrintRequest(
        project,
        { plate: 8, useAms: false, confirmed: true },
        { ...state, sdcard: null },
      ),
    );
    assert.throws(() => buildPrintRequest(project, { plate: 8, useAms: false }, state));
    await writeFile(file, 'this is not a 3mf');
    await assert.rejects(inspectArchive(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only one print can be submitted at a time and busy flag survives upload failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-projects-'));
  let finish;
  const hold = new Promise((resolve) => {
    finish = resolve;
  });
  const printer = {
    jobPending: false,
    assertReady() {},
    snapshot: () => ({ status: 'IDLE', sdcard: true, printError: 0, ams: [] }),
    publish: async () => {},
    event() {},
  };
  const projects = await ProjectService.open(dir, printer, { get: () => ({}) }, async () => {
    await hold;
    throw new Error('FTP failed');
  });
  try {
    const file = path.join(dir, 'fixture.gcode.3mf');
    await archive(file, metadata);
    const saved = await projects.add({ path: file, originalname: 'sample.gcode.3mf', size: 500 });
    const first = projects.start(saved.id, { plate: 8, useAms: false, confirmed: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      projects.start(saved.id, { plate: 8, useAms: false, confirmed: true }),
      /đang|đợi/i,
    );
    finish();
    await assert.rejects(first, /gửi|FTPS|kết nối/i);
    assert.equal(printer.jobPending, false);
    assert.equal((await projects.list()).length, 1);
    await assert.rejects(projects.remove('../../secret'));
  } finally {
    finish();
    await rm(dir, { recursive: true, force: true });
  }
});

test('successful publish keeps a reservation while telemetry still reports IDLE', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-reservation-'));
  let publishes = 0;
  const printer = {
    jobPending: false,
    assertReady() {},
    snapshot: () => ({ status: 'IDLE', sdcard: true, printError: 0, ams: [] }),
    publish: async () => {
      publishes++;
    },
    event() {},
    holdSubmission() {
      this.jobPending = true;
    },
    cancelSubmission() {
      this.jobPending = false;
    },
  };
  const projects = await ProjectService.open(dir, printer, { get: () => ({}) }, async () => {});
  try {
    const file = path.join(dir, 'fixture.gcode.3mf');
    await archive(file, metadata);
    const saved = await projects.add({ path: file, originalname: 'sample.gcode.3mf', size: 500 });
    await projects.start(saved.id, { plate: 8, useAms: false, confirmed: true });
    assert.equal(printer.jobPending, true, 'must wait for printer telemetry after publishing');
    await assert.rejects(
      projects.start(saved.id, { plate: 8, useAms: false, confirmed: true }),
      /đang|đợi/i,
    );
    assert.equal(publishes, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleting a library file removes its printer USB copy and keeps the library file if that delete fails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-usb-delete-'));
  const printer = { jobPending: false, event() {} };
  const projects = await ProjectService.open(dir, printer, { get: () => ({}) });
  try {
    const file = path.join(dir, 'fixture.gcode.3mf');
    await archive(file, metadata);
    const saved = await projects.add({ path: file, originalname: 'sample.gcode.3mf', size: 500 });
    const removed = [];
    projects.storage = {
      async removeOwnedCopy(id) {
        removed.push(id);
        return { removed: true, reason: 'removed' };
      },
    };
    assert.deepEqual(await projects.remove(saved.id), { ok: true, usb: 'removed' });
    assert.deepEqual(removed, [saved.id]);
    assert.equal((await projects.list()).length, 0);

    const againFile = path.join(dir, 'again.gcode.3mf');
    await archive(againFile, metadata);
    const again = await projects.add({
      path: againFile,
      originalname: 'again.gcode.3mf',
      size: 500,
    });
    projects.storage = {
      async removeOwnedCopy() {
        throw new AppError(
          'Không truy cập được USB máy in qua FTPS cổng 990. Kiểm tra Developer Mode, USB và kết nối.',
          502,
        );
      },
    };
    await assert.rejects(projects.remove(again.id), /USB/);
    assert.equal(
      (await projects.list()).some((item) => item.id === again.id),
      true,
      'library file must stay when the USB copy cannot be deleted',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
