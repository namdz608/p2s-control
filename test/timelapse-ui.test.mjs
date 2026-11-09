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
        value: '',
        checked: false,
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
    `UI.settings={configured:true}; UI.timelapse={settings:{auto:true,interval:10,fps:24},active:null,busy:false,clips:[],usedBytes:0};`,
    context,
  );
  return { node, context };
}

test('timelapse library escapes names, exposes playback/download and shows server recording state', async () => {
  const f = await fixture();
  vm.runInContext(
    `UI.timelapse.clips=[{id:'a'.repeat(32),name:'<script>alert(1)</script>',status:'ready',frames:24,fps:24,size:1024,startedAt:'2026-11-08T05:00:00Z',mode:'manual'}];renderTimelapse();`,
    f.context,
  );
  assert.match(f.node('#timelapse-list').innerHTML, /&lt;script/);
  assert.doesNotMatch(f.node('#timelapse-list').innerHTML, /<script>/);
  assert.match(f.node('#timelapse-list').innerHTML, /download=1/);
  assert.match(f.node('#timelapse-list').innerHTML, /data-timelapse-action="play"/);
  vm.runInContext(
    `UI.timelapse.active={id:'a'.repeat(32),status:'recording',frames:3,interval:10,fps:24,name:'Đang in',mode:'auto'};UI.timelapse.busy=true;renderTimelapse();`,
    f.context,
  );
  assert.equal(f.node('#timelapse-start').disabled, true);
  assert.equal(f.node('#timelapse-stop').hidden, false);
  assert.match(f.node('#timelapse-status').textContent, /server|Server/);
});

test('starting a recording sends selected interval/fps and does not depend on live-view being open', async () => {
  const f = await fixture();
  vm.runInContext('renderTimelapse()', f.context);
  f.node('#timelapse-interval').value = '5';
  f.node('#timelapse-fps').value = '30';
  f.node('#timelapse-name').value = 'Tượng';
  vm.runInContext(
    `calls=[]; api=async(url,opts)=>{calls.push({url,opts});return {status:'recording'};};loadState=async()=>{};toast=()=>{};`,
    f.context,
  );
  await vm.runInContext('startTimelapse()', f.context);
  const call = JSON.parse(vm.runInContext('JSON.stringify(calls[0])', f.context));
  assert.equal(call.url, '/timelapses/start');
  assert.deepEqual(call.opts.body, { name: 'Tượng', interval: 5, fps: 30 });
});

test('timelapse page includes auto preference, manual controls and an authenticated video player', async () => {
  const html = await readFile(new URL('../server/views/index.html', import.meta.url), 'utf8');
  for (const id of [
    'page-timelapse',
    'timelapse-auto',
    'timelapse-start',
    'timelapse-stop',
    'timelapse-list',
    'timelapse-player',
  ])
    assert.match(html, new RegExp(`id="${id}"`));
});
