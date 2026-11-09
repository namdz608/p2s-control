import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeReport, summarize } from '../server/models/printer-state.model.mjs';
import { makeCommand } from '../server/services/printer-command.service.mjs';
import { ConfigStore } from '../server/models/printer-config.model.mjs';
import { validateConfig } from '../server/validators/printer-config.validator.mjs';

test('MQTT delta keeps temperatures and replaces AMS arrays without stale trays', () => {
  const original = {
    print: { nozzle_temper: 220, ams: { ams: [{ id: '0', tray: [{ id: '0' }, { id: '1' }] }] } },
  };
  const next = mergeReport(original, {
    print: { mc_percent: 52, ams: { ams: [{ id: '0', tray: [{ id: '2' }] }] } },
  });
  assert.equal(next.print.nozzle_temper, 220);
  assert.equal(next.print.mc_percent, 52);
  assert.deepEqual(next.print.ams.ams[0].tray, [{ id: '2' }]);
  assert.equal(original.print.ams.ams[0].tray.length, 2);
});

test('MQTT report cannot pollute object prototypes', () => {
  const result = mergeReport(
    {},
    JSON.parse(
      '{"__proto__":{"polluted":true},"print":{"constructor":{"prototype":{"polluted":true}},"mc_percent":1}}',
    ),
  );
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(result, '__proto__'), false);
  assert.equal(Object.hasOwn(result.print, 'constructor'), false);
});

test('P2S chamber uses ctc, packed temperatures are not mistaken for degrees, humidity zero is preserved', () => {
  const state = summarize({
    print: {
      gcode_state: 'RUNNING',
      mc_percent: 41,
      device: { ctc: { info: { temp: 27 } }, bed: { info: { temp: 3604535 } } },
      ams: {
        ams: [
          {
            id: '0',
            humidity_raw: '0',
            humidity: '2',
            tray: [{ id: '0', tray_type: 'PLA', tray_color: 'FA6644FF', remain: -1 }],
          },
        ],
      },
    },
  });
  assert.equal(state.chamber, 27);
  assert.equal(state.bed.current, null);
  assert.equal(state.ams[0].humidity, 0);
  assert.equal(state.ams[0].trays[0].remaining, null);
  assert.equal(state.ams[0].trays[0].color, '#FA6644');
  assert.equal(summarize({}).progress, null);
});

test('commands validate temperatures, speed, state and refuse raw G-code', () => {
  assert.equal(makeCommand({ type: 'nozzle', value: 210 }, '9', 'IDLE').print.param, 'M104 S210\n');
  assert.equal(makeCommand({ type: 'speed', value: 2 }, '10', 'RUNNING').print.param, '2');
  assert.throws(() => makeCommand({ type: 'nozzle', value: 301 }, '1', 'IDLE'));
  assert.throws(() => makeCommand({ type: 'bed', value: '60\nG28' }, '1', 'IDLE'));
  assert.throws(() => makeCommand({ type: 'speed', value: 5 }, '1', 'RUNNING'));
  assert.throws(() => makeCommand({ type: 'resume' }, '1', 'RUNNING'));
  assert.throws(() => makeCommand({ type: 'gcode', value: 'G28' }, '1', 'IDLE'));
  assert.equal(makeCommand({ type: 'light', value: true }, '1', 'IDLE').system.led_mode, 'on');
});

test('configuration permits LAN and VPN IPv4 but rejects external services and bad serials', () => {
  const config = {
    name: 'Máy in của bố',
    host: '192.168.1.25',
    serial: '00M00A123456789',
    accessCode: 'aB123456',
  };
  assert.equal(validateConfig(config).host, config.host);
  assert.equal(validateConfig({ ...config, host: '100.100.1.2' }).host, '100.100.1.2');
  for (const host of [
    '127.0.0.1',
    '169.254.169.254',
    '8.8.8.8',
    'localhost',
    '192.168.1.1@evil.com',
  ]) {
    assert.throws(() => validateConfig({ ...config, host }));
  }
  assert.throws(() => validateConfig({ ...config, serial: '../../request' }));
});

test('stored access code is encrypted and never included in public settings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-config-'));
  try {
    const store = await ConfigStore.open(dir);
    await store.save({
      name: 'P2S',
      host: '192.168.1.20',
      serial: '00M00A123456789',
      accessCode: 'aB123456',
    });
    assert.equal(
      (await readFile(path.join(dir, 'printer.json'), 'utf8')).includes('aB123456'),
      false,
    );
    assert.equal(JSON.stringify(store.public()).includes('aB123456'), false);
    assert.equal((await ConfigStore.open(dir)).get().accessCode, 'aB123456');
    await store.save({ ...store.public(), name: 'Đổi tên', accessCode: '' });
    assert.equal(store.get().accessCode, 'aB123456');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a delayed callback from an old printer cannot pin its certificate onto a new printer', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-pin-'));
  try {
    const store = await ConfigStore.open(dir);
    await store.save({
      name: 'A',
      host: '192.168.1.10',
      serial: 'PRINTERA123',
      accessCode: 'test1234',
    });
    const oldIdentity = store.get();
    await store.save({
      name: 'B',
      host: '192.168.1.20',
      serial: 'PRINTERB123',
      accessCode: 'test5678',
    });
    await store.pin('old-certificate', 'OLD-A', oldIdentity);
    assert.equal(
      store.get().fingerprint,
      undefined,
      'new printer must not inherit a stale callback certificate',
    );
    assert.equal((await ConfigStore.open(dir)).get().fingerprint, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
