import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
async function fixture(options = {}) {
  const { TimelapseService } = await import('../server/services/timelapse.service.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'p2s-timelapse-'));
  const state = { fresh: true, status: 'IDLE', task: null, maintenance: { active: false } };
  const printer = { snapshot: () => ({ ...state }), raw: { print: {} }, event() {} };
  const queue = { snapshot: () => ({ active: false }) };
  const encoded = [];
  const dependencies = {
    printer,
    queue,
    capture: async () => jpeg,
    encoder: {
      available: async () => true,
      encode: async (frames, output, fps) => {
        encoded.push({
          frames,
          output,
          fps,
          frameCount: (await readdir(frames)).filter((name) => name.endsWith('.jpg')).length,
        });
        await writeFile(output, 'test-mp4');
      },
    },
    ...options,
  };
  const service = await TimelapseService.open(directory, dependencies);
  return {
    directory,
    state,
    printer,
    dependencies,
    encoded,
    service,
    cleanup: async () => {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('manual recording captures server-side, rejects duplicates and renders a downloadable clip', async () => {
  const f = await fixture();
  try {
    const clip = await f.service.start({ name: 'Bản in thử', interval: 10, fps: 24 });
    assert.equal(clip.status, 'recording');
    assert.equal(clip.frames, 1);
    await assert.rejects(f.service.start({ interval: 10, fps: 24 }), /đang|hiện tại/i);
    await f.service.capture();
    const stopping = await f.service.stop(clip.id);
    assert.equal(stopping.status, 'rendering');
    await f.service.renderPromise;
    const result = f.service.snapshot().clips.find((c) => c.id === clip.id);
    assert.equal(result.status, 'ready');
    assert.equal(result.frames, 2);
    assert.equal(result.duration, 2 / 24);
    assert.equal((await readFile(await f.service.video(clip.id))).toString(), 'test-mp4');
    assert.equal(f.encoded[0].fps, 24);
    await f.service.remove(clip.id);
    assert.equal(f.service.snapshot().clips.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('validation rejects dangerous filenames, invalid timing and missing encoder before capturing', async () => {
  let captures = 0;
  const f = await fixture({
    capture: async () => {
      captures++;
      return jpeg;
    },
  });
  try {
    for (const input of [
      { interval: 0, fps: 24 },
      { interval: 10, fps: 0 },
      { interval: '10', fps: 24 },
      { interval: 10, fps: 121 },
    ])
      await assert.rejects(f.service.start(input));
    await assert.rejects(f.service.video('../secret'));
    await assert.rejects(f.service.remove('../secret'));
    f.service.encoder.available = async () => false;
    await assert.rejects(f.service.start({ interval: 10, fps: 24 }), /FFmpeg/i);
    assert.equal(captures, 0);
  } finally {
    await f.cleanup();
  }
});

test('camera failure releases recording reservation and is visible in the clip list', async () => {
  const f = await fixture({
    capture: async () => {
      throw new Error('camera unavailable');
    },
  });
  try {
    await assert.rejects(f.service.start({ interval: 10, fps: 24 }), /camera/i);
    assert.equal(f.service.snapshot().active, null);
    assert.equal(f.service.snapshot().clips[0].status, 'failed');
  } finally {
    await f.cleanup();
  }
});

test('automatic recording waits for real printing, stops on completion and never records calibration', async () => {
  const f = await fixture();
  try {
    await f.service.updateSettings({ auto: true, interval: 10, fps: 24 });
    await f.service.tick();
    assert.equal(f.service.snapshot().active, null);
    Object.assign(f.state, { status: 'RUNNING', task: 'Tượng nhỏ' });
    f.state.maintenance = { active: true };
    await f.service.tick();
    assert.equal(f.service.snapshot().active, null);
    f.state.maintenance = { active: false };
    await f.service.tick();
    assert.equal(f.service.snapshot().active.mode, 'auto');
    await f.service.capture();
    f.state.status = 'PAUSE';
    await f.service.tick();
    assert.equal(f.service.snapshot().active.status, 'recording');
    f.state.fresh = false;
    f.state.status = 'FINISH';
    await f.service.tick();
    assert.equal(f.service.snapshot().active.status, 'recording');
    f.state.fresh = true;
    await f.service.tick();
    await f.service.renderPromise;
    assert.equal(f.service.snapshot().clips[0].status, 'ready');
    await f.service.tick();
    assert.equal(f.service.snapshot().active, null);
  } finally {
    await f.cleanup();
  }
});

test('manual stop suppresses automatic restart for the same print and records the next print', async () => {
  const f = await fixture();
  try {
    await f.service.updateSettings({ auto: true, interval: 10, fps: 24 });
    Object.assign(f.state, { status: 'RUNNING', task: 'Một' });
    await f.service.tick();
    await f.service.capture();
    await f.service.stop(f.service.snapshot().active.id);
    await f.service.renderPromise;
    await f.service.tick();
    assert.equal(f.service.snapshot().active, null);
    f.state.status = 'FINISH';
    await f.service.tick();
    Object.assign(f.state, { status: 'RUNNING', task: 'Hai' });
    await f.service.tick();
    assert.equal(f.service.snapshot().active.name, 'Hai');
  } finally {
    await f.cleanup();
  }
});

test('restart preserves settings and frames and marks unfinished recordings interrupted', async () => {
  const f = await fixture();
  try {
    await f.service.updateSettings({ auto: true, interval: 15, fps: 30 });
    const clip = await f.service.start({ interval: 15, fps: 30 });
    await f.service.capture();
    await f.service.close();
    const { TimelapseService } = await import('../server/services/timelapse.service.mjs');
    f.service = await TimelapseService.open(f.directory, f.dependencies);
    assert.equal(f.service.snapshot().settings.auto, true);
    assert.equal(f.service.snapshot().clips[0].status, 'interrupted');
    await f.service.render(clip.id);
    await f.service.renderPromise;
    assert.equal(f.service.snapshot().clips[0].status, 'ready');
  } finally {
    await f.cleanup();
  }
});

test('quota stops captures before exceeding frame limits and never deletes completed videos', async () => {
  const f = await fixture({ limits: { maxFrames: 2 } });
  try {
    const clip = await f.service.start({ interval: 10, fps: 24 });
    await f.service.capture();
    await f.service.capture();
    await f.service.renderPromise;
    assert.equal(f.service.snapshot().clips[0].frames, 2);
    assert.equal(f.service.snapshot().clips[0].status, 'ready');
    assert.ok(await f.service.video(clip.id));
  } finally {
    await f.cleanup();
  }
});

test('capture and stop cannot race an in-flight frame into the encoder input', async () => {
  let release;
  let calls = 0;
  const f = await fixture({
    capture: async () => {
      if (++calls === 2)
        await new Promise((resolve) => {
          release = resolve;
        });
      return jpeg;
    },
  });
  try {
    const clip = await f.service.start({ interval: 10, fps: 24 });
    const pending = f.service.capture();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    const stop = f.service.stop(clip.id);
    release();
    await pending;
    await stop;
    await f.service.renderPromise;
    assert.equal(f.service.snapshot().clips[0].frames, 2);
    assert.equal(f.encoded.length, 1);
    assert.equal(f.encoded[0].frameCount, 2);
  } finally {
    await f.cleanup();
  }
});

test('recording refuses a printer configuration change already in progress', async () => {
  const f = await fixture();
  try {
    f.printer.configPending = true;
    await assert.rejects(f.service.start({ interval: 10, fps: 24 }), /kết nối|cấu hình|máy in/i);
  } finally {
    await f.cleanup();
  }
});

test('turning auto off during encoder readiness never starts a recording', async () => {
  const f = await fixture();
  let release;
  try {
    await f.service.updateSettings({ auto: true, interval: 10, fps: 24 });
    f.service.encoder.available = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    Object.assign(f.state, { status: 'RUNNING', task: 'Đang in' });
    const pending = f.service.tick();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await f.service.updateSettings({ auto: false, interval: 10, fps: 24 });
    release(true);
    await pending;
    await f.service.tick();
    assert.equal(f.service.snapshot().active, null);
  } finally {
    await f.cleanup();
  }
});

test('render preparation cannot launch an encoder after close has returned', async () => {
  const f = await fixture();
  let release;
  try {
    const clip = await f.service.start({ interval: 10, fps: 24 });
    await f.service.capture();
    await f.service.close();
    const { TimelapseService } = await import('../server/services/timelapse.service.mjs');
    f.service = await TimelapseService.open(f.directory, f.dependencies);
    f.service.encoder.available = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = f.service.render(clip.id).catch((error) => error);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await f.service.close();
    release(true);
    await pending;
    await f.service.renderPromise;
    assert.equal(f.encoded.length, 0);
    assert.equal(f.service.snapshot().active, null);
  } finally {
    await f.cleanup();
  }
});

test('a delayed filename does not split one automatic print into multiple recordings', async () => {
  const f = await fixture();
  try {
    await f.service.updateSettings({ auto: true, interval: 10, fps: 24 });
    Object.assign(f.state, { status: 'RUNNING', task: 'Tượng' });
    await f.service.tick();
    const id = f.service.snapshot().active.id;
    f.printer.raw.print.gcode_file = 'tuong.gcode';
    await f.service.tick();
    assert.equal(f.service.snapshot().active.id, id);
    assert.equal(f.service.snapshot().clips.length, 1);
  } finally {
    await f.cleanup();
  }
});
