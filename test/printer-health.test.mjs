import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../server/models/printer-state.model.mjs';
import { makeCommand } from '../server/services/printer-command.service.mjs';
import { PrinterService } from '../server/services/printer.service.mjs';
import { ProjectService } from '../server/services/project.service.mjs';

const options = { bedLeveling: true, vibration: true, motorNoise: true };
function printerFixture(settings = {}) {
  const printer = new PrinterService({ get: () => ({ serial: 'TEST123456789' }) }, settings);
  printer.connection = 'connected';
  printer.lastReport = Date.now();
  printer.raw = { print: { gcode_state: 'IDLE', print_error: 0, hms: [], sdcard: true } };
  printer.fieldReports ??= new Map();
  for (const field of Object.keys(printer.raw.print))
    printer.fieldReports.set(field, { at: Date.now(), version: 1 });
  const sent = [];
  printer.publish = async (payload) => sent.push(payload);
  return { printer, sent };
}

test('calibration uses the documented Bambu option bits and requires an explicit selection and confirmation', () => {
  assert.deepEqual(makeCommand({ type: 'calibration', options, confirmed: true }, 7, 'IDLE'), {
    print: { sequence_id: '7', command: 'calibration', option: 14 },
  });
  assert.equal(
    makeCommand(
      { type: 'calibration', options: { bedLeveling: true }, confirmed: true },
      8,
      'FINISH',
    ).print.option,
    2,
  );
  for (const input of [
    { type: 'calibration', options },
    { type: 'calibration', options: {}, confirmed: true },
    { type: 'calibration', options: { vibration: 'true' }, confirmed: true },
    { type: 'calibration', options: { lidar: true }, confirmed: true },
  ])
    assert.throws(() => makeCommand(input, 1, 'IDLE'));
  for (const status of ['RUNNING', 'PAUSE', 'PREPARE', 'SLICING', 'UNKNOWN', 'CALIBRATION'])
    assert.throws(() => makeCommand({ type: 'calibration', options, confirmed: true }, 1, status));
});

test('maintenance reserves the printer before publish and blocks concurrent prints and calibration', async () => {
  const { printer, sent } = printerFixture();
  const projects = new ProjectService(
    {
      get: async () => {
        throw new Error('must not load a file');
      },
    },
    printer,
    {},
  );
  try {
    await printer.command({ type: 'calibration', options, confirmed: true });
    assert.equal(printer.snapshot().maintenance.active, true);
    assert.equal(printer.snapshot().maintenance.status, 'awaiting_start');
    await assert.rejects(
      printer.command({ type: 'calibration', options, confirmed: true }),
      /hiệu chuẩn/i,
    );
    await assert.rejects(projects.start('a', {}), /hiệu chuẩn/i);
    await assert.rejects(projects.queue.start({ confirmed: true }), /hiệu chuẩn/i);
    assert.equal(sent.length, 1);
  } finally {
    await printer.close();
  }
});

test('full system check runs bed, vibration and motor calibration and is allowed after the Y-axis warning', async () => {
  assert.deepEqual(makeCommand({ type: 'systemCheck', confirmed: true }, 9, 'FAILED'), {
    print: { sequence_id: '9', command: 'calibration', option: 14 },
  });
  assert.throws(() => makeCommand({ type: 'systemCheck' }, 1, 'FAILED'));
  assert.throws(() => makeCommand({ type: 'systemCheck', confirmed: true }, 1, 'RUNNING'));
  const { printer, sent } = printerFixture();
  printer.raw.print.gcode_state = 'FAILED';
  printer.raw.print.print_error = 50348044;
  printer.raw.print.hms = [{ attr: 50336000, code: 131074 }];
  for (const field of ['print_error', 'hms'])
    printer.fieldReports.set(field, { at: Date.now(), version: 1 });
  try {
    await printer.command({ type: 'systemCheck', confirmed: true });
    assert.equal(sent[0].print.option, 14);
    assert.equal(sent[0].print.command, 'calibration');
  } finally {
    await printer.close();
  }
  const blocked = printerFixture();
  blocked.printer.raw.print.print_error = 123;
  blocked.printer.fieldReports.set('print_error', { at: Date.now(), version: 1 });
  await assert.rejects(
    blocked.printer.command({ type: 'systemCheck', confirmed: true }),
    /lỗi khác/i,
  );
  assert.equal(blocked.sent.length, 0);
  await blocked.printer.close();
});

test('calibration refuses print faults, stale data, queued work and pending configuration', async () => {
  for (const change of [
    (p) => {
      p.raw.print.print_error = 123;
    },
    (p) => {
      p.lastReport = 0;
    },
    (p) => {
      p.queueActive = true;
    },
    (p) => {
      p.jobPending = true;
    },
    (p) => {
      p.configPending = true;
    },
  ]) {
    const { printer, sent } = printerFixture();
    change(printer);
    await assert.rejects(printer.command({ type: 'calibration', options, confirmed: true }));
    assert.equal(sent.length, 0);
    await printer.close();
  }
});

test('health exposes individual fault codes, rejects malformed HMS and never calls stale data healthy', async () => {
  const { PrinterHealthService } = await import('../server/services/printer-health.service.mjs');
  const { printer } = printerFixture();
  printer.raw.print.hms = [
    { attr: 0x07002100, code: 0x00010086 },
    { attr: '<script>', code: 2 },
    null,
  ];
  printer.raw.print.print_error = 117456933;
  const health = new PrinterHealthService(printer, { lookup: async () => null });
  const report = health.snapshot();
  assert.deepEqual(
    report.faults.map((f) => f.code),
    ['07004025', '0700210000010086'],
  );
  assert.equal(report.faults[1].url, 'https://e.bambulab.com/?e=0700210000010086');
  assert.equal(report.status, 'error');
  printer.lastReport = 0;
  assert.equal(health.snapshot().status, 'unknown');
  assert.ok(health.snapshot().checks.some((c) => c.id === 'telemetry' && c.status !== 'pass'));
  assert.equal(summarize(printer.raw).hms.length, 2);
});

test('error descriptions are cached and lookup failure preserves the original fault', async () => {
  const { PrinterHealthService } = await import('../server/services/printer-health.service.mjs');
  const { printer } = printerFixture();
  printer.raw.print.print_error = 117456933;
  let calls = 0;
  const health = new PrinterHealthService(printer, {
    lookup: async () => {
      calls++;
      return 'Failed to read the filament information.';
    },
  });
  await health.resolveFaults();
  await health.resolveFaults();
  assert.equal(calls, 1);
  assert.equal(health.snapshot().faults[0].description, 'Failed to read the filament information.');
  const unavailable = new PrinterHealthService(printer, {
    lookup: async () => {
      throw new Error('offline');
    },
  });
  await unavailable.resolveFaults();
  assert.equal(unavailable.snapshot().faults[0].code, '07004025');
  assert.match(unavailable.snapshot().faults[0].description, /màn hình/i);
});

test('maintenance completion requires observed calibration telemetry, not a previous FINISH or an acknowledgement', async () => {
  const { printer } = printerFixture();
  await printer.command({ type: 'calibration', options, confirmed: true });
  const seq = printer.snapshot().maintenance.sequence;
  printer.maintenance.observe({
    print: { command: 'calibration', sequence_id: seq, result: 'success' },
  });
  printer.raw.print.gcode_state = 'FINISH';
  printer.maintenance.observe({ print: { gcode_state: 'FINISH' } });
  assert.equal(printer.snapshot().maintenance.status, 'awaiting_start');
  Object.assign(printer.raw.print, {
    gcode_state: 'RUNNING',
    gcode_file: '/usr/etc/print/auto_cali_for_user_param.gcode',
  });
  printer.maintenance.observe({
    print: { gcode_state: 'RUNNING', gcode_file: printer.raw.print.gcode_file },
  });
  assert.equal(printer.snapshot().maintenance.status, 'running');
  printer.raw.print.gcode_state = 'FINISH';
  printer.maintenance.observe({ print: { gcode_state: 'FINISH' } });
  assert.equal(printer.snapshot().maintenance.status, 'completed');
  assert.equal(printer.snapshot().maintenance.active, false);
  await printer.close();
});

test('maintenance rejection is sequence matched and a send timeout remains uncertain', async () => {
  const { printer } = printerFixture();
  await printer.command({ type: 'calibration', options, confirmed: true });
  printer.maintenance.observe({
    print: { command: 'calibration', sequence_id: 'wrong', result: 'fail' },
  });
  assert.equal(printer.snapshot().maintenance.active, true);
  printer.maintenance.observe({
    print: {
      command: 'calibration',
      sequence_id: printer.snapshot().maintenance.sequence,
      result: 'fail',
    },
  });
  assert.equal(printer.snapshot().maintenance.status, 'failed');
  assert.equal(printer.snapshot().maintenance.active, false);
  printer.publish = async () => {
    throw new Error('send timeout');
  };
  await assert.rejects(printer.command({ type: 'calibration', options, confirmed: true }));
  assert.equal(printer.snapshot().maintenance.status, 'uncertain');
  assert.equal(printer.snapshot().maintenance.active, true);
  await printer.close();
});

test('calibration completion after reconnect releases its lock after an observed run', async () => {
  const { printer } = printerFixture();
  try {
    await printer.command({ type: 'calibration', options, confirmed: true });
    Object.assign(printer.raw.print, {
      gcode_state: 'RUNNING',
      gcode_file: 'auto_cali_for_user.gcode',
    });
    printer.maintenance.observe({
      print: { gcode_state: 'RUNNING', gcode_file: 'auto_cali_for_user.gcode' },
    });
    printer.maintenance.uncertain();
    printer.raw.print.gcode_state = 'FINISH';
    printer.maintenance.observe({ print: { gcode_state: 'FINISH', print_error: 0 } });
    assert.equal(printer.snapshot().maintenance.status, 'completed');
    assert.equal(printer.snapshot().maintenance.active, false);
  } finally {
    await printer.close();
  }
});

test('an old calibration filename does not identify an unrelated new task as calibration', async () => {
  const { printer } = printerFixture();
  try {
    printer.raw.print.gcode_file = 'auto_cali_for_user.gcode';
    await printer.command({ type: 'calibration', options, confirmed: true });
    printer.raw.print.gcode_state = 'RUNNING';
    printer.maintenance.observe({ print: { gcode_state: 'RUNNING' } });
    printer.raw.print.gcode_state = 'FINISH';
    printer.maintenance.observe({ print: { gcode_state: 'FINISH' } });
    assert.equal(printer.snapshot().maintenance.status, 'awaiting_start');
  } finally {
    await printer.close();
  }
});

test('a recent temperature alone cannot certify old printer state and errors for calibration', async () => {
  const { PrinterHealthService } = await import('../server/services/printer-health.service.mjs');
  const { printer, sent } = printerFixture();
  for (const field of ['gcode_state', 'print_error', 'hms'])
    printer.fieldReports.set(field, { at: Date.now() - 3600000, version: 1 });
  printer.raw.print.nozzle_temper = 26;
  printer.lastReport = Date.now();
  const health = new PrinterHealthService(printer, { lookup: async () => null });
  assert.equal(health.snapshot().status, 'unknown');
  await assert.rejects(
    printer.command({ type: 'calibration', options, confirmed: true }),
    /trạng thái|dữ liệu/i,
  );
  assert.equal(sent.length, 0);
  await printer.close();
});

test('switching to a different task never reports calibration completed', async () => {
  const { printer } = printerFixture();
  try {
    await printer.command({ type: 'calibration', options, confirmed: true });
    Object.assign(printer.raw.print, {
      gcode_state: 'RUNNING',
      gcode_file: 'auto_cali_for_user.gcode',
    });
    printer.maintenance.observe({
      print: { gcode_state: 'RUNNING', gcode_file: 'auto_cali_for_user.gcode' },
    });
    printer.raw.print.gcode_file = 'other-job.gcode';
    printer.maintenance.observe({ print: { gcode_file: 'other-job.gcode' } });
    printer.raw.print.gcode_state = 'FINISH';
    printer.maintenance.observe({ print: { gcode_state: 'FINISH' } });
    assert.equal(printer.snapshot().maintenance.status, 'uncertain');
    assert.equal(printer.snapshot().maintenance.active, true);
  } finally {
    await printer.close();
  }
});
