import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectService } from '../server/services/project.service.mjs';

function fixture({ sdcard = true, upload = async () => {} } = {}) {
  const state = {
    fresh: true,
    status: 'IDLE',
    sdcard,
    printError: 0,
    ams: [{ id: '0', trays: [0, 1, 2, 3].map((id) => ({ id: String(id), type: 'PLA' })) }],
  };
  const items = [4, 2, 1, 3].map((n) => ({
    id: String(n).repeat(32),
    name: `0${n}-Part-AMS${n}`,
    plates: [{ number: 1, filamentCount: n, filaments: [{ id: n, type: 'PLA' }] }],
  }));
  const sent = [];
  const printer = {
    jobPending: false,
    configPending: false,
    events: [],
    snapshot: () => ({ ...state, jobPending: printer.jobPending }),
    assertReady() {
      assert.equal(state.fresh, true);
    },
    event() {},
    holdSubmission() {
      this.jobPending = true;
    },
    cancelSubmission() {
      this.jobPending = false;
    },
    async publish(payload) {
      sent.push(payload);
    },
  };
  const model = {
    list: async () => items,
    get: async (id) => items.find((p) => p.id === id),
    file: (id) => id,
    remove: async () => {},
  };
  const projects = new ProjectService(model, printer, { get: () => ({}) }, upload);
  return { projects, queue: projects.queue, state, printer, sent, items };
}

async function settle(queue) {
  await queue.inFlight;
}

test('one action queues every file by numeric name and waits for actual matching job completion', async () => {
  const f = fixture();
  assert.ok(f.queue, 'server must provide a print queue');
  try {
    await f.queue.start({ confirmed: true });
    await settle(f.queue);
    assert.deepEqual(
      f.queue.snapshot().items.map((i) => i.name),
      [1, 2, 3, 4].map((n) => `0${n}-Part-AMS${n}`),
    );
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].print.ams_mapping, [0]);
    // A previous job's FINISH must never advance the new submission.
    Object.assign(f.state, { status: 'FINISH', task: 'old-job' });
    await f.queue.tick();
    assert.equal(f.sent.length, 1);
    for (let n = 1; n <= 4; n++) {
      Object.assign(f.state, { status: 'RUNNING', task: `0${n}-Part-AMS${n}` });
      f.printer.jobPending = false;
      await f.queue.tick();
      assert.equal(f.sent.length, n);
      Object.assign(f.state, { status: 'PAUSE' });
      await f.queue.tick();
      assert.equal(f.sent.length, n);
      Object.assign(f.state, { status: 'FINISH' });
      await f.queue.tick();
      await settle(f.queue);
    }
    assert.equal(f.sent.length, 4);
    assert.deepEqual(f.sent[3].print.ams_mapping, [-1, -1, -1, 3]);
    assert.equal(f.queue.snapshot().status, 'completed');
    assert.equal(f.printer.queueActive, false);
  } finally {
    f.queue.cancel();
  }
});

test('queue checks all files before sending and clearly reports missing storage', async () => {
  const f = fixture({ sdcard: false });
  assert.ok(f.queue, 'server must provide a print queue');
  await assert.rejects(f.queue.start({ confirmed: true }), /thẻ nhớ/i);
  assert.equal(f.sent.length, 0);
  assert.equal(f.printer.queueActive, false);
});

test('ambiguous AMS mapping fails before any file is sent', async () => {
  const f = fixture();
  assert.ok(f.queue, 'server must provide a print queue');
  f.items[0].name = 'Unspecified-part';
  await assert.rejects(f.queue.start({ confirmed: true }), /AMS|khay/i);
  assert.equal(f.sent.length, 0);
});

test('queue owns print submission and deletion until cancelled, even while waiting for telemetry', async () => {
  const f = fixture();
  assert.ok(f.queue, 'server must provide a print queue');
  try {
    await f.queue.start({ confirmed: true });
    await settle(f.queue);
    f.printer.jobPending = false;
    await assert.rejects(f.queue.start({ confirmed: true }), /hàng đợi/i);
    await assert.rejects(
      f.projects.start(f.items[0].id, { plate: 1, confirmed: true, useAms: false }),
      /hàng đợi/i,
    );
    await assert.rejects(f.projects.remove(f.items[0].id), /hàng đợi/i);
    f.queue.cancel();
    Object.assign(f.state, { status: 'FINISH', task: '01-Part-AMS1' });
    await f.queue.tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.queue.snapshot().status, 'cancelled');
  } finally {
    f.queue.cancel();
  }
});

test('failure, rejected submission, wrong job and stale connection never send the next file', async () => {
  for (const scenario of ['FAILED', 'rejected', 'wrong', 'stale', 'timeout']) {
    const f = fixture();
    assert.ok(f.queue, 'server must provide a print queue');
    try {
      await f.queue.start({ confirmed: true });
      await settle(f.queue);
      if (scenario === 'timeout') {
        f.queue.submittedAt = Date.now() - 120000;
      } else if (scenario === 'rejected') {
        f.printer.jobPending = false;
      } else {
        f.printer.jobPending = false;
        Object.assign(f.state, { status: 'RUNNING', task: '01-Part-AMS1' });
        await f.queue.tick();
        if (scenario === 'wrong') Object.assign(f.state, { task: 'foreign-job', status: 'FINISH' });
        else if (scenario === 'stale') Object.assign(f.state, { fresh: false, status: 'FINISH' });
        else Object.assign(f.state, { status: 'FAILED' });
      }
      await f.queue.tick();
      assert.equal(f.sent.length, 1, scenario);
      assert.equal(
        f.queue.snapshot().status,
        scenario === 'stale' ? 'printing' : 'failed',
        scenario,
      );
    } finally {
      f.queue.cancel();
    }
  }
});

test('cancel during FTPS upload never publishes a print command', async () => {
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({ upload: () => hold });
  assert.ok(f.queue, 'server must provide a print queue');
  try {
    await f.queue.start({ confirmed: true });
    f.queue.cancel();
    release();
    await settle(f.queue);
    assert.equal(f.sent.length, 0);
    assert.equal(f.printer.jobPending, false);
  } finally {
    release();
    f.queue.cancel();
  }
});

test('a previous FAILED state and delayed task name do not discard the accepted queue', async () => {
  const f = fixture();
  f.state.status = 'FAILED';
  assert.ok(f.queue);
  try {
    await f.queue.start({ confirmed: true });
    await settle(f.queue);
    await f.queue.tick();
    assert.equal(f.queue.snapshot().status, 'awaiting_start');
    // Busy telemetry can arrive before the subtask_name delta.
    f.state.status = 'PREPARE';
    f.state.task = 'previous-job';
    f.printer.jobPending = false;
    await f.queue.tick();
    assert.equal(f.queue.snapshot().status, 'awaiting_start');
    f.state.task = '01-Part-AMS1';
    await f.queue.tick();
    assert.equal(f.queue.snapshot().status, 'printing');
    assert.equal(f.sent.length, 1);
  } finally {
    f.queue.cancel();
  }
});

test('all plates are queued numerically and invalid later files prevent any submission', async () => {
  const f = fixture();
  try {
    f.items[2].plates.push({ ...f.items[2].plates[0], number: 2 });
    await f.queue.start({ confirmed: true });
    await settle(f.queue);
    assert.deepEqual(
      f.queue.snapshot().items.map((i) => [i.name, i.plate]),
      [
        ['01-Part-AMS1', 1],
        ['01-Part-AMS1', 2],
        ['02-Part-AMS2', 1],
        ['03-Part-AMS3', 1],
        ['04-Part-AMS4', 1],
      ],
    );
  } finally {
    f.queue.cancel();
  }
  const invalid = fixture();
  invalid.items[0].plates[0].filaments[0].type = 'ABS';
  await assert.rejects(invalid.queue.start({ confirmed: true }), /AMS|khay/i);
  assert.equal(invalid.sent.length, 0);
});

test('FTPS failure stops the queue and releases its reservation', async () => {
  const f = fixture({
    upload: async () => {
      throw new Error('FTPS failed');
    },
  });
  await f.queue.start({ confirmed: true });
  await settle(f.queue);
  assert.equal(f.queue.snapshot().status, 'failed');
  assert.match(f.queue.snapshot().message, /FTPS/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.printer.jobPending, false);
  assert.equal(f.printer.queueActive, false);
});
