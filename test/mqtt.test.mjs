import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as tlsConnect } from 'node:tls';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Aedes from 'aedes';
import { PrinterService } from '../server/services/printer.service.mjs';

const until = async (predicate) => {
  const deadline = Date.now() + 7000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for MQTT');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};

test('real MQTT over TLS authenticates, subscribes, merges deltas, sends commands and blocks stale/offline control', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-mqtt-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${dir}/key.pem`,
      '-out',
      `${dir}/cert.pem`,
      '-days',
      '1',
      '-subj',
      '/CN=p2s-test',
    ],
    { stdio: 'ignore' },
  );
  const broker = Aedes();
  broker.authenticate = (_client, user, password, callback) =>
    callback(null, user === 'bblp' && password?.toString() === 'test1234');
  const server = createServer(
    { key: await readFile(`${dir}/key.pem`), cert: await readFile(`${dir}/cert.pem`) },
    broker.handle,
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let value = { host: '127.0.0.1', serial: 'TEST123456789', accessCode: 'test1234' };
  const store = {
    get: () => ({ ...value }),
    pin: async (certificate, fingerprint) => {
      value = { ...value, certificate, fingerprint };
    },
  };
  const printer = new PrinterService(store, { port: server.address().port, freshnessMs: 1000 });
  const commands = [];
  broker.on('publish', (packet, client) => {
    if (client && packet.topic.endsWith('/request'))
      commands.push(JSON.parse(packet.payload.toString()));
  });
  try {
    await printer.start();
    await until(() => printer.snapshot().connection === 'connected');
    await until(() => commands.some((command) => command.pushing?.command === 'pushall'));
    const report = (payload) =>
      new Promise((resolve, reject) =>
        broker.publish(
          {
            topic: 'device/TEST123456789/report',
            payload: Buffer.from(JSON.stringify(payload)),
            qos: 0,
            retain: false,
          },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    await report({ print: { gcode_state: 'RUNNING', nozzle_temper: 220, mc_percent: 10 } });
    await until(() => printer.snapshot().progress === 10);
    await report({ print: { mc_percent: 11 } });
    await until(() => printer.snapshot().progress === 11);
    const refresh = printer.refreshStatus();
    let refreshed = false;
    refresh.then(() => {
      refreshed = true;
    });
    await report({ print: { command: 'calibration', result: 'success' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(refreshed, false, 'a command acknowledgement is not fresh telemetry');
    await report({ print: { mc_percent: 12 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(refreshed, false, 'progress alone cannot refresh the health and fault state');
    await report({ print: { gcode_state: 'RUNNING', hms: [], print_error: 0 } });
    await refresh;
    assert.equal(refreshed, true);
    await report({ print: { hms: [null] } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      printer.snapshot().healthFresh,
      false,
      'malformed HMS must not certify a healthy printer',
    );
    await report({ print: { hms: [] } });
    await until(() => printer.snapshot().healthFresh);
    assert.equal(printer.snapshot().nozzle.current, 220);
    assert.ok(value.fingerprint);
    await printer.command({ type: 'pause' });
    await until(() => commands.some((command) => command.print?.command === 'pause'));
    await assert.rejects(printer.refreshStatus(30), /phản hồi trạng thái/i);
    printer.lastReport = Date.now() - 2000;
    await assert.rejects(printer.command({ type: 'stop' }), /dữ liệu|kết nối/i);
    await printer.close();
    await assert.rejects(printer.command({ type: 'light', value: true }), /kết nối/i);
  } finally {
    await printer.close();
    await new Promise((resolve) => broker.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('MQTT trusts a pinned device certificate signed by an unavailable CA and rejects a changed pin', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2s-mqtt-issued-'));
  const openssl = (...args) => execFileSync('openssl', args, { stdio: 'ignore' });
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${dir}/ca-key.pem`,
    '-out',
    `${dir}/ca.pem`,
    '-days',
    '1',
    '-subj',
    '/CN=printer-test-ca',
  );
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${dir}/key.pem`,
    '-out',
    `${dir}/request.pem`,
    '-subj',
    '/CN=printer-test',
  );
  openssl(
    'x509',
    '-req',
    '-in',
    `${dir}/request.pem`,
    '-CA',
    `${dir}/ca.pem`,
    '-CAkey',
    `${dir}/ca-key.pem`,
    '-CAcreateserial',
    '-out',
    `${dir}/cert.pem`,
    '-days',
    '1',
  );
  const broker = Aedes();
  broker.authenticate = (_client, user, password, callback) =>
    callback(null, user === 'bblp' && password?.toString() === 'test1234');
  const server = createServer(
    { key: await readFile(`${dir}/key.pem`), cert: await readFile(`${dir}/cert.pem`) },
    broker.handle,
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let value = { host: '127.0.0.1', serial: 'TEST123456789', accessCode: 'test1234' };
  const store = {
    get: () => ({ ...value }),
    pin: async (certificate, fingerprint) => {
      value = { ...value, certificate, fingerprint };
    },
  };
  const printer = new PrinterService(store, { port: server.address().port });
  try {
    await printer.start();
    await until(() => printer.snapshot().connection === 'connected');
    assert.ok(value.fingerprint, 'authenticated device certificate must be pinned');
    await printer.close();
    value = { ...value, fingerprint: 'CHANGED-CERTIFICATE' };
    await printer.start();
    assert.equal(printer.snapshot().connection, 'error');
    assert.match(printer.snapshot().message, /Chứng chỉ máy in đã thay đổi/);
    assert.equal(value.fingerprint, 'CHANGED-CERTIFICATE', 'changed pin must not be overwritten');
  } finally {
    await printer.close();
    await new Promise((resolve) => broker.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
