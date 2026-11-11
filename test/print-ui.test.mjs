import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function ui() {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        textContent: '',
        innerHTML: '',
        hidden: false,
        disabled: false,
        classList: { toggle() {} },
        addEventListener() {},
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
    `UI.printer = { fresh: true, connection: 'connected', status: 'IDLE', sdcard: false, printError: 0 }; api = async url => url.includes('queue') ? { active: false, status: 'idle', items: [] } : [{ id: 'a', name: '01-Part-AMS1', size: 10, addedAt: '2026-11-08', plates: [{number: 1}] }];`,
    context,
  );
  return { nodes, node, context };
}

test('missing SD card does not lock the print setup button without explanation', async () => {
  const f = await ui();
  await vm.runInContext('loadProjects()', f.context);
  const html = f.node('#projects-list').innerHTML;
  assert.doesNotMatch(
    html,
    /class="[^"]*project-print[^>]*\sdisabled(?:\s|>)/,
    'print setup must remain clickable so the user can inspect the blocking reason',
  );
});

test('a reported printer error does not disable the print button', async () => {
  const f = await ui();
  f.node('#print-dialog').open = true;
  vm.runInContext(
    `UI.projects = []; UI.printer = { fresh: true, status: 'IDLE', sdcard: true, printError: 50348044, jobPending: false, configPending: false, maintenance: { active: false } }; UI.queue = { active: false, status: 'idle', items: [], completed: 0 }; renderPrintControls();`,
    f.context,
  );
  assert.equal(f.node('#print-form button[type=submit]').disabled, false);
  assert.equal(f.node('#print-error').textContent, '');
  assert.doesNotMatch(f.node('#print-readiness').textContent, /báo lỗi/);
});

test('the file picker uploads every selected sliced file and keeps going after one rejection', async () => {
  const f = await ui();
  const sent = [];
  f.context.File = File;
  f.context.FormData = FormData;
  vm.runInContext(
    `api = async (_url, options) => { const file = options.body.get('file'); sent.push(file.name); if (file.name.startsWith('bad')) throw new Error('tệp hỏng'); return {}; }; loadProjects = async () => { reloaded = true }; toast = (message) => { notices.push(message) }; sent = []; notices = []; reloaded = false;`,
    f.context,
  );
  f.context.sent = sent;
  f.node('#file-input').files = [
    new File(['a'], '01.gcode.3mf'),
    new File(['b'], 'note.txt'),
    new File(['c'], 'bad.gcode.3mf'),
    new File(['d'], '02.gcode.3mf'),
  ];
  await assert.rejects(vm.runInContext('uploadFile()', f.context), /note\.txt/);
  assert.deepEqual([...f.context.sent], ['01.gcode.3mf', 'bad.gcode.3mf', '02.gcode.3mf']);
  assert.deepEqual([...f.context.notices], ['Đã thêm 2 tệp vào thư viện.']);
  assert.equal(f.context.reloaded, true);
  const html = await readFile(new URL('../server/views/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="file-input"[^>]*\bmultiple\b/);
});

test('library navigation filters files and offers a destination for upload and moving files', async () => {
  const f = await ui();
  vm.runInContext(
    `
    UI.folderId = 'folder-a';
    api = async url => url === '/projects/folders' ? [
      {id: 'folder-a', name: 'Batman <parts>'}, {id: 'folder-b', name: 'Other'}
    ] : [
      {id: 'old', name: 'Legacy', plates: [], size: 12, addedAt: '2026-11-08'},
      {id: 'inside', name: 'Head', folderId: 'folder-a', plates: [], size: 10, addedAt: '2026-11-08'},
      {id: 'outside', name: 'Base', folderId: 'folder-b', plates: [], size: 10, addedAt: '2026-11-08'}
    ];
  `,
    f.context,
  );
  await vm.runInContext('loadProjects()', f.context);
  assert.match(f.node('#projects-list').innerHTML, /Head/);
  assert.doesNotMatch(f.node('#projects-list').innerHTML, /Legacy|Base/);
  assert.equal(f.node('#upload-folder').value, 'folder-a');
  assert.match(f.node('#upload-folder').innerHTML, /Batman &lt;parts&gt;/);
  assert.match(f.node('#projects-list').innerHTML, /data-move-project="inside"/);
  assert.match(f.node('#library-folders').innerHTML, /data-drop-folder="folder-b"/);
  vm.runInContext("openLibraryFolder('')", f.context);
  assert.match(f.node('#projects-list').innerHTML, /Legacy/);
  assert.doesNotMatch(f.node('#projects-list').innerHTML, />Head<|>Base</);
  assert.equal(f.node('#upload-folder').value, '');
});

test('file picker sends the selected folder with every upload', async () => {
  const f = await ui();
  f.context.FormData = FormData;
  f.context.sent = [];
  f.node('#upload-folder').value = 'folder-b';
  f.node('#file-input').files = [new File(['a'], '01.gcode.3mf'), new File(['b'], '02.gcode.3mf')];
  vm.runInContext(
    `
    UI.folderId = 'folder-a';
    api = async (_url, options) => { sent.push([options.body.get('file').name, options.body.get('folderId')]); return {}; };
    loadProjects = async () => {}; toast = () => {};
  `,
    f.context,
  );
  await vm.runInContext('uploadFile()', f.context);
  assert.deepEqual(
    f.context.sent.map((item) => Array.from(item)),
    [
      ['01.gcode.3mf', 'folder-b'],
      ['02.gcode.3mf', 'folder-b'],
    ],
  );
});

test('dropping local files uploads into the drop target and dropping an existing file moves it', async () => {
  const f = await ui();
  f.context.FormData = FormData;
  f.context.sent = [];
  vm.runInContext(
    `
    UI.projects = [{ id: 'inside', folderId: 'folder-a', name: 'Head' }];
    api = async (url, options) => {
      sent.push({url, method: options.method, folderId: options.body instanceof FormData ? options.body.get('folderId') : options.body.folderId});
      return {};
    };
    loadProjects = async () => {}; toast = () => {};
  `,
    f.context,
  );
  let prevented = 0;
  const target = { dataset: { dropFolder: 'folder-b' }, classList: { remove() {} } };
  f.context.dropEvent = {
    preventDefault() {
      prevented++;
    },
    target: { closest: () => target },
    dataTransfer: { files: [new File(['a'], '01.gcode.3mf')], getData: () => '' },
  };
  await vm.runInContext('handleLibraryDrop(dropEvent)', f.context);
  f.context.dropEvent.dataTransfer = { files: [], getData: () => 'inside' };
  await vm.runInContext('handleLibraryDrop(dropEvent)', f.context);
  assert.equal(prevented, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.sent)), [
    { url: '/projects', method: 'POST', folderId: 'folder-b' },
    { url: '/projects/inside/folder', method: 'PATCH', folderId: 'folder-b' },
  ]);
});

test('file library has one action to start every file and a visible readiness explanation', async () => {
  const html = await readFile(new URL('../server/views/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="print-all-button"/);
  assert.match(html, /id="print-readiness"/);
  assert.match(html, /id="queue-status"/);
});

async function grayPrintSetup({
  name = '04-Than-chan-XAM-AMS4',
  colors = ['#FFFFFF', '#000000', '#E8C4B0', '#808080'],
  emptyFourth = false,
  mode = 'auto',
} = {}) {
  const f = await ui();
  f.node('#print-source').value = 'ams';
  f.node('#print-plate').value = '1';
  f.node('#print-mapping-mode').value = mode;
  const trays = colors.map((color, id) => ({
    id: String(id),
    type: emptyFourth && id === 3 ? '' : 'PLA',
    color,
  }));
  vm.runInContext(
    `UI.selectedProject = ${JSON.stringify({ name, plates: [{ number: 1, filamentCount: 4, filaments: [{ id: 4, type: 'PLA', color: '#808080' }] }] })}; UI.printer.ams = ${JSON.stringify([{ id: '0', trays }])}; renderMapping();`,
    f.context,
  );
  return f.node('#print-mapping').innerHTML;
}

test('individual print automatically maps gray filament 4 to the gray fourth AMS tray and shows its color', async () => {
  const html = await grayPrintSetup();
  assert.match(html, /<option\b[^>]*value="3"[^>]*\bselected\b/);
  assert.doesNotMatch(html, /<option\b[^>]*value="[012]"[^>]*\bselected\b/);
  assert.match(html, /Xám/);
  assert.match(html, /#808080/);
  assert.match(html, /A4/);
});

test('individual print finds the unique color match even without an AMS suffix', async () => {
  const html = await grayPrintSetup({ name: 'gray-part' });
  assert.match(html, /<option\b[^>]*value="3"[^>]*\bselected\b/);
});

test('individual print never substitutes black when the required gray tray is unconfigured', async () => {
  const html = await grayPrintSetup({ emptyFourth: true });
  assert.doesNotMatch(html, /<option\b[^>]*value="\d+"[^>]*\bselected\b/);
  assert.match(html, /A4[^<]*chưa khai báo/i);
  assert.match(html, /<option\b[^>]*value="1"[^>]*\bdisabled\b/);
});

test('individual print leaves ambiguous gray trays for explicit selection', async () => {
  const html = await grayPrintSetup({
    name: 'gray-part',
    colors: ['#808080', '#000000', '#E8C4B0', '#808080'],
  });
  assert.doesNotMatch(html, /<option\b[^>]*value="\d+"[^>]*\bselected\b/);
  assert.match(html, /nhiều khay/i);
});

test('individual print does not silently replace an explicitly named fourth tray with another gray tray', async () => {
  const html = await grayPrintSetup({ colors: ['#808080', '#000000', '#E8C4B0', '#FFFFFF'] });
  assert.doesNotMatch(html, /<option\b[^>]*value="\d+"[^>]*\bselected\b/);
  assert.match(html, /A4[^<]*không khớp/);
});

test('individual print matches RGB colors case insensitively and ignores the alpha channel', async () => {
  const html = await grayPrintSetup({
    colors: ['#ffffffFF', '#000000FF', '#e8c4b0FF', '#808080FF'],
  });
  assert.match(html, /<option\b[^>]*value="3"[^>]*\bselected\b/);
});

test('manual individual print exposes A1-A4 without preselecting or locking trays to the filename or color', async () => {
  const html = await grayPrintSetup({ mode: 'manual' });
  assert.match(html, /Chọn khay in/);
  assert.match(html, /<input\b[^>]*type="hidden"[^>]*data-filament="4"[^>]*value=""/);
  for (const value of [0, 1, 2, 3]) {
    const button = html.match(new RegExp(`<button\\b[^>]*data-print-tray="${value}"[^>]*>`))?.[0];
    assert.ok(button, `A${value + 1} must be a directly clickable button`);
    assert.doesNotMatch(button, /\bdisabled\b/);
    assert.match(button, /type="button"/);
    assert.match(button, /aria-pressed="false"/);
  }
});

test('manual individual print allows an unconfigured tray while clearly showing its unknown material', async () => {
  const html = await grayPrintSetup({ mode: 'manual', emptyFourth: true });
  const button = html.match(/<button\b[^>]*data-print-tray="3"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /\bdisabled\b/);
  assert.match(button, /Chưa khai báo/);
});

test('manual print reads A2 for filament 4 and explains the selected spool color', async () => {
  const f = await ui();
  f.node('#print-source').value = 'ams';
  f.node('#print-plate').value = '1';
  f.node('#print-mapping-mode').value = 'manual';
  f.node('[data-filament="4"]').value = '1';
  vm.runInContext(
    `UI.selectedProject = { name: 'gray-AMS4', plates: [{ number: 1, filamentCount: 4, filaments: [{ id: 4, type: 'PLA', color: '#808080' }] }] }; UI.printer.ams = [{ id: '0', trays: [{ id: '1', type: 'PLA', color: '#000000' }] }]; updateMappingSummary();`,
    f.context,
  );
  const mapping = vm.runInContext('readPrintMapping(UI.selectedProject.plates[0])', f.context);
  assert.deepEqual(Array.from(mapping), [-1, -1, -1, 1]);
  assert.match(f.node('#print-mapping-summary').textContent, /A2/);
  assert.match(f.node('#print-mapping-summary').textContent, /khác màu/i);
});

test('an unselected tray cannot silently become A1 when building an individual print', async () => {
  const f = await ui();
  f.node('#print-source').value = 'ams';
  f.node('[data-filament="4"]').value = '';
  assert.throws(
    () =>
      vm.runInContext('readPrintMapping({ filamentCount: 4, filaments: [{ id: 4 }] })', f.context),
    /Chọn khay/,
  );
});

test('manual print preserves the project filament positions when selecting more than one tray', async () => {
  const f = await ui();
  f.node('#print-source').value = 'ams';
  f.node('[data-filament="1"]').value = '1';
  f.node('[data-filament="4"]').value = '3';
  const mapping = vm.runInContext(
    'readPrintMapping({ filamentCount: 4, filaments: [{ id: 1 }, { id: 4 }] })',
    f.context,
  );
  assert.deepEqual(Array.from(mapping), [1, -1, -1, 3]);
});

test('manual selection summary identifies an unconfigured A4 and asks to check the sliced material', async () => {
  const f = await ui();
  f.node('#print-source').value = 'ams';
  f.node('#print-plate').value = '1';
  f.node('#print-mapping-mode').value = 'manual';
  f.node('[data-filament="4"]').value = '3';
  vm.runInContext(
    `UI.selectedProject = { name: 'gray-AMS4', plates: [{ number: 1, filamentCount: 4, filaments: [{ id: 4, type: 'PLA', color: '#808080' }] }] }; UI.printer.ams = [{ id: '0', trays: [{ id: '3', type: '', color: '#70777d' }] }]; updateMappingSummary();`,
    f.context,
  );
  const text = f.node('#print-mapping-summary').textContent;
  assert.match(text, /A4/);
  assert.match(text, /chưa khai báo/i);
  assert.match(text, /PLA/);
});
