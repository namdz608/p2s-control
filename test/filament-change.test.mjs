import test from 'node:test';
import assert from 'node:assert/strict';
import { PrinterService } from '../server/services/printer.service.mjs';
import { mergeReport } from '../server/models/printer-state.model.mjs';

const doorSweep = [
  'G90',
  'G1 Z200 F1200',
  'G1 X128 Y40 F6000',
  'G1 Z120 F800',
  'G1 X70 F2400',
  'G1 X186 F2400',
  'G1 X128 F2400',
  'G1 Y70 F2400',
  'G1 Y40 F2400',
  '',
].join('\n');
const extruder = (slot = 0, { busy = false, moving = false, loaded = slot !== 255 } = {}) => ({
  device: {
    extruder: {
      state: 1 | (busy ? 1 << 19 : 0),
      info: [{ id: 0, snow: slot, info: (loaded ? 2 : 0) | (moving ? 1 << 11 : 0) }],
    },
  },
});

function setup(t) {
  const printer = new PrinterService({});
  const sent = [];
  printer.connection = 'connected';
  printer.publish = async (payload) => {
    if (payload.print) sent.push(payload.print);
  };
  t.after(() => printer.close());
  function report(delta) {
    const message = { print: delta };
    printer.raw = mergeReport(printer.raw, message);
    printer.recordTelemetry(delta);
    return printer.filamentChange?.observe(message);
  }
  report({
    gcode_state: 'IDLE',
    print_error: 0,
    hms: [],
    nozzle_temper: 24,
    nozzle_target_temper: 0,
    ams_status: 0,
    ams: {
      ams: [
        {
          id: '0',
          tray: [
            { id: '0', tray_type: 'PLA' },
            { id: '1', tray_type: 'PETG' },
          ],
        },
      ],
    },
    ...extruder(),
  });
  const start = (source = '0:1') =>
    printer.command({
      type: 'filamentChange',
      action: 'start',
      confirmed: true,
      source,
      oldTemp: 215,
      newTemp: 240,
    });
  const action = (action, confirmed = true) =>
    printer.command({
      type: 'filamentChange',
      action,
      confirmed,
      id: printer.snapshot().filamentChange.id,
    });
  const status = () => printer.snapshot().filamentChange.status;
  return { printer, sent, report, start, action, status };
}

test('heats and extrudes the gripped old filament before sending unload or load', async (t) => {
  const { sent, report, start, action, status } = setup(t);
  await start();
  assert.equal(status(), 'heating_old');
  assert.equal(sent[0].param, 'M104 S215\n');
  await assert.rejects(action('pushOld'), /đủ nhiệt/);
  await report({ nozzle_target_temper: 215, nozzle_temper: 215 });
  assert.equal(status(), 'ready_old');
  await assert.rejects(action('pushOld', false), /xác nhận/i);
  await action('pushOld');
  assert.equal(sent[1].command, 'set_extrusion_length');
  assert.equal(sent[1].length, 10);
  await report({ command: sent[1].command, sequence_id: sent[1].sequence_id, result: 'success' });
  assert.equal(sent.length, 2);
  await report(extruder(0, { moving: true }));
  await assert.rejects(action('confirmOld'), /đang đẩy|xác minh/i);
  await report(extruder());
  assert.equal(status(), 'verify_old');
  await action('confirmOld');
  assert.equal(sent[2].target, 255);
  await report({ ...extruder(255), ams_status: 0 });
  assert.equal(sent.length, 3, 'a resting report alone is insufficient');
  await report({ ...extruder(0, { busy: true }), ams_status: 0x103 });
  await report({ ...extruder(255), ams_status: 0 });
  assert.equal(sent[3].target, 1);
  await report({ ...extruder(255, { busy: true }), ams_status: 0x105 });
  await report({ ...extruder(1), ams_status: 0 });
  assert.equal(status(), 'verify_new');
  await action('finish');
  assert.equal(status(), 'cooling');
  await report({ nozzle_target_temper: 0 });
  assert.equal(status(), 'completed');
  assert.equal(sent.at(-1).param, 'M104 S0\n');
});

test('external filament waits for insertion after the old filament is removed', async (t) => {
  const { sent, report, start, action, status } = setup(t);
  await start('external');
  await report({ nozzle_target_temper: 215, nozzle_temper: 215 });
  await action('pushOld');
  await report(extruder(0, { moving: true }));
  await report(extruder());
  await action('confirmOld');
  await report({ ...extruder(0, { busy: true }), ams_status: 0x103 });
  await report({ ...extruder(255), ams_status: 0 });
  assert.equal(status(), 'waiting_external');
  assert.equal(sent.length, 3);
  await action('loadExternal');
  assert.equal(sent[3].ams_id, 255);
  assert.equal(sent[3].slot_id, 0, 'external load uses slot 0, unlike unload');
  assert.equal(sent[3].target, 255);
});

test('same AMS slot waits for the user to swap spools before sending a load', async (t) => {
  const { sent, report, start, action, status } = setup(t);
  await start('0:0');
  await report({ nozzle_temper: 215 });
  await report({ nozzle_target_temper: 215 });
  await action('pushOld');
  await report({
    ...extruder(),
    command: sent[1].command,
    sequence_id: sent[1].sequence_id,
    result: 'success',
  });
  assert.equal(status(), 'verify_old');
  await action('confirmOld');
  await report({ ...extruder(0, { busy: true }), ams_status: 0x103 });
  await report({ ...extruder(255), ams_status: 0 });
  assert.equal(status(), 'waiting_ams_swap');
  assert.equal(sent.length, 3);
  await action('loadAms');
  assert.equal(sent[3].target, 0);
});

test('refuses noncanonical tray ids before heating', async (t) => {
  const { sent, start } = setup(t);
  await assert.rejects(start('00:0'), /khay AMS/);
  assert.equal(sent.length, 0);
});

test('unload waits for new valid AMS state, including when P2S reports in separate deltas', async (t) => {
  const { sent, report, start, action, status } = setup(t);
  await start();
  await report({ nozzle_target_temper: 215, nozzle_temper: 215 });
  await action('pushOld');
  await report(extruder(0, { moving: true }));
  await report(extruder());
  await action('confirmOld');
  await report(extruder(0, { busy: true }));
  await report(extruder(255));
  await report({ ams_status: null });
  assert.equal(status(), 'unloading');
  assert.equal(sent.length, 3);
  await report({ ams_status: 0 });
  assert.equal(sent[3].target, 1);
});

test('a motion timeout holds the lock and does not act on the printer', async (t) => {
  const { printer, sent, report, start, action, status } = setup(t);
  await start();
  await report({ nozzle_target_temper: 215, nozzle_temper: 215 });
  await action('pushOld');
  await printer.filamentChange.expire();
  await report({ nozzle_target_temper: 0 });
  assert.equal(status(), 'uncertain');
  assert.equal(printer.snapshot().filamentChange.active, true);
  assert.equal(sent.length, 2);
});

test('rejects an ungripped old filament and prevents another action after the operation loses its connection', async (t) => {
  const { printer, sent, report, start, action, status } = setup(t);
  await report(extruder(255));
  await assert.rejects(start(), /sợi cũ/);
  assert.equal(sent.length, 0);
  await report(extruder());
  await start();
  await assert.rejects(
    printer.command({ type: 'nozzle', value: 250, confirmed: true }),
    /filament/,
  );
  printer.filamentChange.interrupt();
  await report({ nozzle_target_temper: 215, nozzle_temper: 215 });
  await assert.rejects(action('pushOld'), /bước|trạng thái/);
  assert.equal(status(), 'uncertain');
  assert.equal(sent.length, 1);
});

const stalledPullback = {
  gcode_state: 'PAUSE',
  ams_status: 0x104,
  print_error: 0x07008004,
  hms: [
    { attr: 0x07002300, code: 0x00020011 },
    { attr: 0x03001100, code: 0x00020002 },
  ],
  nozzle_target_temper: 42,
  ...extruder(3, { busy: true, loaded: false }),
};

test('purge at the paused AMS pullback fault heats, pushes once and restores the previous target', async (t) => {
  const { printer, sent, report, action, status } = setup(t);
  await report(stalledPullback);
  const start = await printer.command({
    type: 'filamentChange',
    action: 'startPurge',
    confirmed: true,
    temperature: 220,
  });
  assert.equal(start.mode, 'purge');
  assert.equal(sent[0].command, 'gcode_line');
  assert.equal(sent[0].param, 'M104 S220\n');
  assert.equal(status(), 'awaiting_purge_heat');
  await report({ nozzle_target_temper: 42, nozzle_temper: 42 });
  assert.equal(status(), 'awaiting_purge_heat');
  await assert.rejects(action('pushPurge'), /đủ nhiệt/);
  await report({ nozzle_target_temper: 220 });
  assert.equal(status(), 'heating_purge');
  await report({ nozzle_target_temper: 220, nozzle_temper: 220 });
  assert.equal(status(), 'ready_purge');
  await assert.rejects(action('pushPurge', false), /xác nhận/);
  await action('pushPurge');
  assert.equal(sent[1].command, 'set_extrusion_length');
  assert.equal(sent[1].length, 10);
  await assert.rejects(action('pushPurge'), /bước/);
  await report({
    ...extruder(3, { busy: true, moving: true, loaded: false }),
    print_error: 0x07008004,
  });
  await report(extruder(3, { busy: true, loaded: false }));
  assert.equal(status(), 'restoring_purge');
  assert.deepEqual(
    sent.map((message) => message.command),
    ['gcode_line', 'set_extrusion_length', 'gcode_line'],
  );
  assert.equal(sent[2].param, 'M104 S42\n');
  await report({ nozzle_target_temper: 42 });
  assert.equal(status(), 'completed');
  assert.equal(printer.snapshot().status, 'PAUSE');
});

test('purge guards a moving extruder and stops sending commands when printing resumes', async (t) => {
  const { printer, sent, report, action, status } = setup(t);
  const start = () =>
    printer.command({
      type: 'filamentChange',
      action: 'startPurge',
      confirmed: true,
      temperature: 220,
    });
  await report({ ...stalledPullback, ...extruder(3, { busy: true, moving: true }) });
  await assert.rejects(start(), /máy đang bận|đầu đùn đang/i);
  assert.equal(sent.length, 0);
  await report(stalledPullback);
  await start();
  await report({ nozzle_target_temper: 220, nozzle_temper: 220, gcode_state: 'RUNNING' });
  await assert.rejects(action('pushPurge'), /trạng thái/);
  assert.equal(status(), 'uncertain');
  assert.equal(sent.length, 1);
});

test('a rejected purge restores temperature without repeating the extrusion', async (t) => {
  const { printer, sent, report, action, status } = setup(t);
  await report(stalledPullback);
  await printer.command({
    type: 'filamentChange',
    action: 'startPurge',
    confirmed: true,
    temperature: 220,
  });
  await report({ nozzle_target_temper: 220, nozzle_temper: 220 });
  await action('pushPurge');
  await report({ command: sent[1].command, sequence_id: sent[1].sequence_id, result: 'fail' });
  assert.equal(status(), 'restoring_purge');
  assert.equal(sent.at(-1).param, 'M104 S42\n');
  await report({ nozzle_target_temper: 42 });
  assert.equal(status(), 'cancelled');
  assert.match(printer.snapshot().filamentChange.message, /từ chối đùn/);
  assert.equal(sent.filter((payload) => payload.command === 'set_extrusion_length').length, 1);
});

test('cancel purge during heating orders restoration even before a heating report arrives', async (t) => {
  const { printer, sent, report, action, status } = setup(t);
  await report(stalledPullback);
  await printer.command({
    type: 'filamentChange',
    action: 'startPurge',
    confirmed: true,
    temperature: 220,
  });
  await action('cancel');
  assert.equal(status(), 'restoring_purge');
  await report({ nozzle_target_temper: 42 });
  assert.equal(status(), 'restoring_purge', 'the old target alone does not confirm restoration');
  await report({ nozzle_target_temper: 220 });
  assert.equal(status(), 'restoring_purge');
  await report({ nozzle_target_temper: 42 });
  assert.equal(status(), 'cancelled');
  assert.deepEqual(
    sent.map((payload) => payload.param),
    ['M104 S220\n', 'M104 S42\n'],
  );
});

test('ending an unconfirmed purge unlocks resume when the nozzle is already at the old target', async (t) => {
  const { printer, sent, report, action, status } = setup(t);
  await report(stalledPullback);
  await printer.command({
    type: 'filamentChange',
    action: 'startPurge',
    confirmed: true,
    temperature: 240,
  });
  await printer.filamentChange.expire();
  assert.equal(status(), 'restoring_purge');
  await printer.filamentChange.expire();
  assert.equal(status(), 'uncertain');
  assert.equal(printer.snapshot().filamentChange.active, true);
  const sentBeforeCancel = sent.length;
  await action('cancel');
  assert.equal(status(), 'cancelled');
  assert.equal(printer.snapshot().filamentChange.active, false);
  assert.equal(sent.length, sentBeforeCancel);
  const controlsLocked = Boolean(printer.snapshot().filamentChange.active);
  assert.equal(controlsLocked || printer.snapshot().status !== 'PAUSE', false);
});

test('cancel purge cannot write the old temperature to a different paused print', async (t) => {
  const { printer, sent, report, action, status } = setup(t);
  await report({ ...stalledPullback, gcode_file: 'old-print' });
  await printer.command({
    type: 'filamentChange',
    action: 'startPurge',
    confirmed: true,
    temperature: 220,
  });
  await report({ ...stalledPullback, gcode_file: 'different-print', nozzle_target_temper: 220 });
  assert.equal(status(), 'uncertain');
  await action('cancel');
  assert.equal(status(), 'cancelled');
  assert.deepEqual(
    sent.map((payload) => payload.param),
    ['M104 S220\n'],
  );
});

test('purge requires an actual temperature of at least 170 degrees', async (t) => {
  const { printer, sent, report, action, status } = setup(t);
  await report(stalledPullback);
  await printer.command({
    type: 'filamentChange',
    action: 'startPurge',
    confirmed: true,
    temperature: 170,
  });
  await report({ nozzle_target_temper: 170, nozzle_temper: 168 });
  assert.equal(status(), 'heating_purge');
  await report({ nozzle_temper: 170 });
  assert.equal(status(), 'ready_purge');
  await report({ nozzle_temper: 169 });
  await assert.rejects(action('pushPurge'), /đủ nhiệt/);
  assert.equal(sent.length, 1);
});

test('heats the nozzle and only then moves it out to the front door', async (t) => {
  const { printer, sent, report, action, status } = setup(t);
  await printer.command({
    type: 'filamentChange',
    action: 'startClear',
    confirmed: true,
    temperature: 220,
  });
  assert.equal(status(), 'awaiting_clear_heat');
  assert.equal(sent[0].command, 'gcode_line');
  assert.equal(sent[0].param, 'M104 S220\n');
  await report({ nozzle_temper: 220 });
  assert.equal(status(), 'awaiting_clear_heat');
  assert.equal(sent.length, 1);
  await report({ nozzle_target_temper: 220, nozzle_temper: 200 });
  assert.equal(status(), 'heating_clear');
  assert.equal(sent.length, 1);
  await report({ nozzle_temper: 220 });
  assert.equal(status(), 'moving_clear');
  assert.equal(sent[1].param, doorSweep);
  assert.doesNotMatch(sent[1].param, /G150/);
  await report({ command: 'gcode_line', sequence_id: sent[1].sequence_id, result: 'success' });
  assert.equal(status(), 'parked_clear');
  assert.equal(sent.length, 2);
  assert.match(printer.snapshot().filamentChange.message, /cửa/);
  await action('cancel');
  assert.equal(sent.at(-1).param, 'M104 S0\n');
  await report({ nozzle_target_temper: 0 });
  assert.equal(status(), 'cancelled');
});

test('a hot nozzle does not move once the printer leaves idle or the extruder is moving', async (t) => {
  const { printer, sent, report, status } = setup(t);
  const start = () =>
    printer.command({
      type: 'filamentChange',
      action: 'startClear',
      confirmed: true,
      temperature: 220,
    });
  await start();
  await report({ gcode_state: 'RUNNING', nozzle_target_temper: 220, nozzle_temper: 220 });
  assert.equal(status(), 'uncertain');
  assert.deepEqual(
    sent.map((payload) => payload.param),
    ['M104 S220\n'],
  );

  const moving = setup(t);
  await moving.printer.command({
    type: 'filamentChange',
    action: 'startClear',
    confirmed: true,
    temperature: 220,
  });
  await moving.report({
    nozzle_target_temper: 220,
    nozzle_temper: 220,
    ...extruder(0, { moving: true }),
  });
  assert.equal(moving.status(), 'uncertain');
  assert.deepEqual(
    moving.sent.map((payload) => payload.param),
    ['M104 S220\n'],
  );
});

test('clearing a stuck nozzle heats and moves while an existing printer error remains', async (t) => {
  const { printer, sent, report, status } = setup(t);
  const stuck = {
    print_error: 0x03004001,
    hms: [{ attr: 0x07000000, code: 0x00020001 }],
  };
  await report(stuck);
  await printer.command({
    type: 'filamentChange',
    action: 'startClear',
    confirmed: true,
    temperature: 220,
  });
  assert.equal(status(), 'awaiting_clear_heat');
  assert.equal(sent[0].param, 'M104 S220\n');
  await report({ ...stuck, nozzle_target_temper: 220, nozzle_temper: 220 });
  assert.equal(status(), 'moving_clear');
  assert.equal(sent[1].param, doorSweep);
  assert.doesNotMatch(sent[1].param, /G150/);
});

test('clearing a stuck nozzle refuses a busy printer, a missing confirmation, and a cold target', async (t) => {
  const { printer, sent, report } = setup(t);
  await assert.rejects(
    printer.command({ type: 'filamentChange', action: 'startClear', temperature: 220 }),
    /xác nhận/i,
  );
  await assert.rejects(
    printer.command({
      type: 'filamentChange',
      action: 'startClear',
      confirmed: true,
      temperature: 160,
    }),
    /170/,
  );
  await report({ gcode_state: 'RUNNING' });
  await assert.rejects(
    printer.command({
      type: 'filamentChange',
      action: 'startClear',
      confirmed: true,
      temperature: 220,
    }),
    /bận|rảnh/i,
  );
  assert.equal(sent.length, 0);
});

test('a rejected door move is not sent again', async (t) => {
  const { printer, sent, report, status } = setup(t);
  await printer.command({
    type: 'filamentChange',
    action: 'startClear',
    confirmed: true,
    temperature: 220,
  });
  await report({ nozzle_target_temper: 220, nozzle_temper: 220 });
  assert.equal(sent[1].param, doorSweep);
  assert.doesNotMatch(sent[1].param, /G150/);
  await report({ command: 'gcode_line', sequence_id: sent[1].sequence_id, result: 'fail' });
  assert.equal(status(), 'uncertain');
  await report({ nozzle_temper: 220, nozzle_target_temper: 220 });
  assert.equal(sent.length, 2);
});
