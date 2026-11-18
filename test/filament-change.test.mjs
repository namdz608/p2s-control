import test from 'node:test';
import assert from 'node:assert/strict';
import { PrinterService } from '../server/services/printer.service.mjs';
import { mergeReport } from '../server/models/printer-state.model.mjs';

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
