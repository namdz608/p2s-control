import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function fixture() {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        textContent: '',
        innerHTML: '',
        hidden: false,
        disabled: false,
        checked: true,
        classList: { toggle() {} },
        addEventListener() {},
        setAttribute() {},
      });
    return nodes.get(selector);
  };
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll: () => [] },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source.slice(0, source.indexOf("$('#today')")), context);
  vm.runInContext(
    `UI.settings = { configured: true }; UI.printer = {fresh:true,status:'IDLE',printError:0,maintenance:{active:false}};`,
    context,
  );
  return { node, context };
}

test('health page renders specific faults safely and labels stale reports explicitly', async () => {
  const f = await fixture();
  vm.runInContext(
    `UI.health = { status: 'unknown', faults: [{kind:'hms',code:'0700210000010086',title:'AMS',severity:'error',description:'<img src=x onerror=alert(1)>',url:'https://e.bambulab.com/?e=0700210000010086'}], checks:[{title:'Dữ liệu',status:'unknown',message:'Chưa có dữ liệu mới'}] }; renderHealth();`,
    f.context,
  );
  assert.match(f.node('#fault-list').innerHTML, /0700210000010086/);
  assert.match(f.node('#fault-list').innerHTML, /&lt;img/);
  assert.doesNotMatch(f.node('#fault-list').innerHTML, /<img/);
  assert.match(f.node('#health-summary').textContent, /Chưa xác minh/i);
  assert.match(f.node('#health-checks').innerHTML, /Chưa có dữ liệu mới/);
});

test('calibration requires confirmation and sends only chosen options', async () => {
  const f = await fixture();
  f.node('#calibration-motorNoise').checked = false;
  vm.runInContext(
    `calls=[]; confirmAction=async()=>false; api=async(u,o)=>{calls.push({u,o});return {message:'Đã gửi'};}; loadState=async()=>{}; toast=()=>{};`,
    f.context,
  );
  await vm.runInContext('calibratePrinter()', f.context);
  assert.equal(vm.runInContext('calls.length', f.context), 0);
  vm.runInContext('confirmAction=async()=>true;', f.context);
  await vm.runInContext('calibratePrinter()', f.context);
  const call = JSON.parse(vm.runInContext('JSON.stringify(calls[0])', f.context));
  assert.equal(call.u, '/printer/commands');
  assert.deepEqual(call.o.body, {
    type: 'calibration',
    confirmed: true,
    options: { bedLeveling: true, vibration: true, motorNoise: false },
  });
});

test('active calibration disables new print submission and explains the reason', async () => {
  const f = await fixture();
  vm.runInContext(
    `UI.printer.sdcard=true; UI.printer.maintenance={active:true,status:'awaiting_start',message:'Chờ máy'};`,
    f.context,
  );
  assert.equal(vm.runInContext('canPrint()', f.context), false);
  assert.match(vm.runInContext('printReadiness()', f.context), /hiệu chuẩn/i);
  vm.runInContext('renderHealth()', f.context);
  assert.equal(f.node('#calibration-start').disabled, true);
  assert.equal(f.node('#system-check').disabled, true);
});

test('a fresh temperature without fresh fault fields never renders a healthy fault list', async () => {
  const f = await fixture();
  vm.runInContext(
    `UI.printer.healthFresh=false; UI.health={status:'unknown',faults:[],lastReport:'2026-11-08T05:00:00Z'}; renderHealth();`,
    f.context,
  );
  assert.match(f.node('#fault-list').innerHTML, /Cần dữ liệu mới/);
  assert.match(f.node('#health-updated').textContent, /Dữ liệu cũ/);
});

test('diagnostics has a dedicated page, visible fault banner and an explicit calibration form', async () => {
  const html = await readFile(new URL('../server/views/index.html', import.meta.url), 'utf8');
  for (const id of [
    'page-health',
    'fault-banner',
    'health-checks',
    'fault-list',
    'diagnostics-run',
    'calibration-form',
    'system-check',
  ])
    assert.match(html, new RegExp(`id="${id}"`));
});
