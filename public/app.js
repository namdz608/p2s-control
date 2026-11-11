const API_BASE = '/api/v1';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const number = (value) =>
  value === null || value === undefined ? '—' : Math.round(value).toLocaleString('vi-VN');
const statusLabels = {
  UNKNOWN: 'Chưa có dữ liệu',
  IDLE: 'Sẵn sàng',
  RUNNING: 'Đang in',
  PAUSE: 'Tạm dừng',
  FINISH: 'Hoàn thành',
  FAILED: 'Có lỗi',
  PREPARE: 'Đang chuẩn bị',
  SLICING: 'Đang xử lý',
};
const connectionLabels = {
  unconfigured: 'Chưa kết nối',
  offline: 'Ngoại tuyến',
  connecting: 'Đang kết nối',
  connected: 'Đã kết nối',
  error: 'Lỗi kết nối',
};
const speedLabels = ['—', 'Êm ái', 'Tiêu chuẩn', 'Thể thao', 'Tối đa'];
const UI = {
  page: 'overview',
  settings: {},
  printer: {},
  health: {},
  checking: false,
  calibrating: false,
  timelapse: {
    settings: { auto: false, interval: 10, fps: 24 },
    active: null,
    clips: [],
    busy: false,
  },
  timelapseBusy: false,
  timelapseSettingsKey: '',
  projects: [],
  folders: [],
  folderId: '',
  uploadBusy: false,
  usb: { path: '/', parent: null, entries: [], truncated: false, loaded: false },
  usbBusy: false,
  queue: { active: false, status: 'idle', items: [] },
  queueSubmitting: false,
  timer: null,
  loading: false,
  camera: false,
  selectedProject: null,
  temperature: null,
  materialsKey: '',
  toastTimer: null,
};

async function api(url, options = {}) {
  const { timeout = 30000, ...rest } = options;
  const headers = { ...rest.headers };
  if (rest.body !== undefined && !(rest.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    rest.body = JSON.stringify(rest.body);
  }
  const response = await fetch(`${API_BASE}${url}`, {
    credentials: 'same-origin',
    ...rest,
    headers,
    signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && url !== '/auth/login') showLogin();
    throw new Error(data.error || 'Không thực hiện được yêu cầu.');
  }
  return data;
}
function toast(message, error = false) {
  clearTimeout(UI.toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  UI.toastTimer = setTimeout(
    () => {
      $('#toast').hidden = true;
    },
    error ? 8000 : 5000,
  );
}
const report = (error) =>
  toast(
    error.name === 'TimeoutError'
      ? 'Yêu cầu quá thời gian chờ. Kiểm tra trạng thái máy trước khi thử lại.'
      : error.message || 'Không kết nối được server.',
    true,
  );
const action = (fn) => async (event) => {
  try {
    await fn(event);
  } catch (error) {
    report(error);
  }
};
function showLogin() {
  clearInterval(UI.timer);
  UI.timer = null;
  cameraClose();
  $$('dialog[open]').forEach((dialog) => dialog.close());
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  UI.settings = {};
  UI.printer = {};
  UI.health = {};
  UI.checking = false;
  UI.calibrating = false;
  UI.timelapse = {
    settings: { auto: false, interval: 10, fps: 24 },
    active: null,
    clips: [],
    busy: false,
  };
  UI.timelapseBusy = false;
  UI.timelapseSettingsKey = '';
  UI.projects = [];
  UI.folders = [];
  UI.folderId = '';
  UI.usb = { path: '/', parent: null, entries: [], truncated: false, loaded: false };
  UI.usbBusy = false;
  UI.queue = { active: false, status: 'idle', items: [] };
  UI.queueSubmitting = false;
  UI.materialsKey = '';
}
async function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  await Promise.all([loadState(), loadProjects()]);
  clearInterval(UI.timer);
  UI.timer = setInterval(() => {
    if (!document.hidden) loadState().catch(() => {});
  }, 3000);
}
async function loadState() {
  if (UI.loading) return;
  UI.loading = true;
  try {
    const data = await api('/printer');
    UI.settings = data.settings;
    UI.printer = data.printer;
    UI.health = data.health || {};
    UI.timelapse = data.timelapse || UI.timelapse;
    UI.queue = data.queue || { active: false, status: 'idle', items: [] };
    renderState(data.events);
  } catch (error) {
    if (!$('#app-view').hidden) {
      UI.printer.fresh = false;
      UI.health.status = 'unknown';
      renderHealth();
      disableControls();
      renderPrintControls();
      $('#connection-banner').hidden = false;
      $('#banner-title').textContent = 'Mất kết nối với webapp';
      $('#banner-text').textContent =
        'Không nhận được trạng thái mới. Kiểm tra đường mạng và tải lại trang.';
      $('#banner-action').textContent = 'Thử lại';
    }
    throw error;
  } finally {
    UI.loading = false;
  }
}
function disableControls() {
  $$(
    '#pause-button, #resume-button, #stop-button, #light-toggle, [data-speed], [data-temperature]',
  ).forEach((button) => {
    button.disabled = true;
  });
}
function renderState(events = []) {
  const p = UI.printer;
  const connected = p.connection === 'connected';
  const fresh = Boolean(p.fresh);
  const label = connectionLabels[p.connection] || 'Chưa kết nối';
  $('#sidebar-status').textContent = label;
  $('#sidebar-dot').className = `tiny-dot ${fresh ? '' : 'muted-dot'}`;
  $('#connection-pill').className = `pill ${fresh ? 'connected' : ''}`;
  $('#connection-pill').innerHTML =
    `<i class="tiny-dot ${fresh ? '' : 'muted-dot'}"></i>${escape(fresh ? statusLabels[p.status] || p.status : label)}`;
  $('#printer-name').textContent = UI.settings.configured ? UI.settings.name : 'P2S Combo';
  $('#connection-banner').hidden = fresh;
  $('#connection-banner').classList.toggle('is-error', ['error', 'offline'].includes(p.connection));
  $('#banner-title').textContent = !UI.settings.configured
    ? 'Bắt đầu với chiếc P2S của bạn'
    : connected && !fresh
      ? 'Đang chờ dữ liệu mới từ máy in'
      : label;
  $('#banner-text').textContent = UI.settings.configured
    ? p.message || 'Kiểm tra kết nối máy in.'
    : 'Thêm thông tin máy in để xem trạng thái và điều khiển.';
  $('#banner-action').innerHTML =
    `${UI.settings.configured ? 'Kiểm tra kết nối' : 'Thiết lập ngay'} ${icon('arrow')}`;
  $('#job-name').textContent =
    p.task || (fresh ? 'Sẵn sàng cho ý tưởng tiếp theo' : 'Chưa có tác vụ từ máy in');
  $('#job-description').textContent = p.task
    ? 'Bản in đang được theo dõi'
    : fresh
      ? 'Chọn một tệp để bắt đầu tác vụ mới.'
      : 'Kết nối máy in để bắt đầu theo dõi.';
  $('#job-status').textContent = statusLabels[p.status] || p.status || 'Chưa có dữ liệu';
  $('#job-progress').innerHTML = `${number(p.progress)}<small>%</small>`;
  $('#job-progress-bar').style.width = `${Math.max(0, Math.min(100, p.progress || 0))}%`;
  $('#job-layers').textContent = `${number(p.layer)} / ${number(p.totalLayers)}`;
  $('#job-remaining').textContent =
    p.remaining === null || p.remaining === undefined ? '—' : duration(p.remaining);
  for (const key of ['nozzle', 'bed']) {
    $(`#${key}-current`).textContent = number(p[key]?.current);
    $(`#${key}-target`).textContent = number(p[key]?.target);
  }
  $('#chamber-current').textContent = number(p.chamber);
  $('#last-updated').textContent = p.lastReport
    ? `${fresh ? 'Cập nhật' : 'Dữ liệu gần nhất'} ${new Date(p.lastReport).toLocaleTimeString('vi-VN')}`
    : connected
      ? 'Đang chờ dữ liệu'
      : 'Chờ kết nối';
  const ready = fresh && !p.jobPending && !p.configPending;
  $('#pause-button').disabled = !ready || Boolean(p.maintenance?.active) || p.status !== 'RUNNING';
  $('#resume-button').disabled = !ready || Boolean(p.maintenance?.active) || p.status !== 'PAUSE';
  $('#stop-button').disabled =
    !ready || !['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'].includes(p.status);
  $('#light-toggle').disabled = !ready;
  $('#light-toggle').setAttribute('aria-checked', String(Boolean(p.light)));
  $('[data-temperature="nozzle"]').disabled = !ready || Boolean(p.maintenance?.active);
  $('[data-temperature="bed"]').disabled = !ready || Boolean(p.maintenance?.active);
  $('[data-temperature="nozzle"]').title = ready
    ? 'Đặt nhiệt độ đầu phun'
    : 'Cần kết nối và dữ liệu mới từ máy in';
  $('#speed-label').textContent = speedLabels[p.speed] || '—';
  $$('[data-speed]').forEach((button) => {
    button.disabled =
      !ready || Boolean(p.maintenance?.active) || !['RUNNING', 'PAUSE'].includes(p.status);
    button.classList.toggle('selected', Number(button.dataset.speed) === p.speed);
  });
  renderPrintControls();
  renderHealth();
  renderTimelapse();
  renderUsb();
  $('#camera-open').disabled = !UI.settings.configured;
  $('#footer-connection').textContent = p.jobPending
    ? 'ĐANG GỬI TÁC VỤ IN…'
    : fresh
      ? 'ĐANG ĐỒNG BỘ VỚI MÁY IN'
      : 'ĐANG CHỜ MÁY IN';
  const materialsKey = JSON.stringify(p.ams || []);
  if (materialsKey !== UI.materialsKey || !$('#ams-overview').children.length) {
    UI.materialsKey = materialsKey;
    renderMaterials();
  }
  const printError = p.printError
    ? `<div class="activity-item"><i class="tiny-dot error-dot"></i><div><p>Máy in đang báo lỗi 0x${Number(p.printError).toString(16).toUpperCase().padStart(8, '0')}. Kiểm tra màn hình P2S.</p></div></div>`
    : '';
  const hms = p.hms?.length
    ? `<div class="activity-item"><i class="tiny-dot error-dot"></i><div><p>Máy in có ${p.hms.length} cảnh báo HMS. Xem chi tiết trên màn hình máy.</p></div></div>`
    : '';
  $('#activity-list').innerHTML =
    printError +
      hms +
      events
        .slice(0, printError || hms ? 2 : 3)
        .map(
          (item) =>
            `<div class="activity-item"><i class="tiny-dot ${item.kind === 'error' ? 'error-dot' : 'muted-dot'}"></i><div><p>${escape(item.message)}</p><time datetime="${escape(item.at)}">${new Date(item.at).toLocaleTimeString('vi-VN')}</time></div></div>`,
        )
        .join('') ||
    '<div class="empty-activity">Các thay đổi trạng thái sẽ xuất hiện tại đây.</div>';
}
function duration(minutes) {
  const value = Math.max(0, Math.round(minutes));
  return value >= 60 ? `${Math.floor(value / 60)} giờ ${value % 60} phút` : `${value} phút`;
}
function calibrationReadiness() {
  const p = UI.printer;
  if (p.maintenance?.active)
    return 'Đang hiệu chuẩn hoặc đang chờ xác minh kết quả. Theo dõi máy trước khi chạy lại.';
  if (!p.fresh) return 'Cần kết nối và dữ liệu mới từ máy in.';
  if (p.healthFresh === false)
    return 'Cần dữ liệu trạng thái và lỗi mới. Chạy kiểm tra kết nối trước khi hiệu chuẩn.';
  if (UI.queue.active || p.jobPending || p.configPending)
    return 'Đợi tác vụ hoặc hủy hàng đợi trước khi hiệu chuẩn.';
  if (!['IDLE', 'FINISH', 'FAILED'].includes(p.status))
    return 'Chỉ chạy hiệu chuẩn khi máy đang rảnh.';
  if (p.printError || UI.health.faults?.some((f) => f.severity === 'error'))
    return 'Xử lý lỗi máy in trước khi hiệu chuẩn.';
  return '';
}
const recoverableMaintenanceCodes = new Set(['0300400C', '0300110000020002']);
const recoverablePrintErrors = new Set([0, 50348044]);
function systemCheckReadiness() {
  const blocked = calibrationReadiness();
  if (!blocked) return '';
  if (blocked !== 'Xử lý lỗi máy in trước khi hiệu chuẩn.') return blocked;
  const faults = (UI.health.faults || []).filter((fault) => fault.severity === 'error');
  const printOk =
    !UI.printer.printError || recoverablePrintErrors.has(Number(UI.printer.printError));
  const faultsOk = faults.every((fault) => recoverableMaintenanceCodes.has(fault.code));
  return printOk && faultsOk
    ? ''
    : 'Còn lỗi khác trên máy. Xử lý lỗi đó trước khi kiểm tra toàn hệ thống.';
}
function renderHealth() {
  const health = UI.health || {};
  const fresh = UI.printer.fresh && UI.printer.healthFresh !== false;
  const faults = health.faults || [];
  const labels = {
    ok: 'Không phát hiện bất thường trong dữ liệu hiện tại',
    warning: 'Có mục cần kiểm tra',
    error: 'Máy đang báo lỗi',
    unknown: 'Chưa xác minh được tình trạng máy',
  };
  const status = fresh ? health.status || 'unknown' : 'unknown';
  $('#health-summary').textContent = labels[status] || labels.unknown;
  $('#health-summary').className = `health-summary health-${status}`;
  $('#health-updated').textContent = health.lastReport
    ? `Dữ liệu gần nhất: ${new Date(health.lastReport).toLocaleString('vi-VN')}${fresh ? '' : ' · Dữ liệu cũ'}`
    : 'Chưa nhận dữ liệu máy in.';
  $('#fault-count').textContent = String(faults.length);
  $('#fault-count').hidden = !faults.length;
  $('#fault-banner').hidden = !faults.length;
  $('#fault-banner-text').textContent =
    `${fresh ? 'Máy đang báo' : 'Dữ liệu gần nhất ghi nhận'} ${faults.length} lỗi/cảnh báo. Xem mã lỗi và hướng dẫn xử lý.`;
  const severity = { error: 'Lỗi', warning: 'Cảnh báo', info: 'Thông tin' };
  const faultHtml = faults.length
    ? faults
        .map((f) => {
          const validCode = /^(?:[0-9A-F]{8}|[0-9A-F]{16})$/.test(f.code);
          return `<article class="fault-item"><div class="fault-heading"><strong>${escape(f.title)}</strong><span class="health-tag ${f.severity === 'error' ? 'health-error' : 'health-warning'}">${severity[f.severity] || 'Cảnh báo'}</span></div><code>${escape(f.code)}</code><p>${escape(f.description)}</p>${validCode ? `<a class="text-button" href="https://e.bambulab.com/?e=${f.code}" target="_blank" rel="noopener noreferrer">Hướng dẫn Bambu ${icon('arrow')}</a>` : ''}</article>`;
        })
        .join('')
    : `<p class="health-empty">${fresh ? 'Không có lỗi in hoặc cảnh báo HMS trong dữ liệu hiện tại.' : 'Cần dữ liệu mới để kiểm tra lỗi trên máy.'}</p>`;
  if ($('#fault-list').innerHTML !== faultHtml) $('#fault-list').innerHTML = faultHtml;
  const checkLabels = { pass: 'Đạt', fail: 'Lỗi', warning: 'Cần kiểm tra', unknown: 'Chưa rõ' };
  const checksHtml = (health.checks || [])
    .map(
      (c) =>
        `<div class="health-check"><div><strong>${escape(c.title)}</strong><p>${escape(c.message)}</p></div><span class="health-tag health-${c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'error' : c.status}">${checkLabels[c.status] || 'Chưa rõ'}</span></div>`,
    )
    .join('');
  if ($('#health-checks').innerHTML !== checksHtml) $('#health-checks').innerHTML = checksHtml;
  $('#diagnostics-run').disabled = UI.checking || !UI.settings.configured;
  $('#diagnostics-run').textContent = UI.checking
    ? 'Đang kiểm tra…'
    : 'Kiểm tra kết nối & trạng thái';
  $('#diagnostics-result').textContent = health.lastCheck
    ? `${new Date(health.lastCheck.at).toLocaleTimeString('vi-VN')} · ${health.lastCheck.message}`
    : 'Bấm kiểm tra để yêu cầu trạng thái mới từ máy in.';
  const reason = calibrationReadiness();
  $('#calibration-readiness').textContent =
    reason || 'Máy đang rảnh. Dọn sạch bàn in và kiểm tra vùng chuyển động trước khi chạy.';
  $('#calibration-start').disabled = UI.calibrating || Boolean(reason);
  $('#calibration-start').textContent = UI.calibrating ? 'Đang gửi yêu cầu…' : 'Chạy hiệu chuẩn';
  const systemReason = systemCheckReadiness();
  $('#system-check').disabled = UI.calibrating || Boolean(systemReason);
  $('#system-check').textContent = UI.calibrating
    ? 'Đang gửi yêu cầu…'
    : 'Kiểm tra lại toàn hệ thống';
  $('#system-check-readiness').textContent =
    systemReason ||
    'Máy sẽ cân bàn, đo rung trục và giảm ồn động cơ. Lau thanh trượt Y và dọn bàn trước khi bấm.';
  $('#calibration-status').textContent =
    UI.printer.maintenance?.message || 'Chưa chạy hiệu chuẩn trong phiên này.';
}
async function runDiagnostics() {
  if (UI.checking) return;
  UI.checking = true;
  $('#health-error').textContent = '';
  renderHealth();
  try {
    UI.health = await api('/printer/diagnostics', { method: 'POST', body: {}, timeout: 30000 });
    await loadState();
  } catch (error) {
    $('#health-error').textContent = error.message;
    throw error;
  } finally {
    UI.checking = false;
    renderHealth();
  }
}
async function runSystemCheck() {
  if (UI.calibrating) return;
  const reason = systemCheckReadiness();
  if (reason) throw new Error(reason);
  UI.calibrating = true;
  renderHealth();
  try {
    if (
      !(await confirmAction(
        'Kiểm tra lại toàn hệ thống?',
        'Máy sẽ cân bàn in, bù rung và giảm ồn động cơ. Lau thanh trượt trục Y, dọn sạch bàn và để trống vùng chuyển động. Máy có thể gia nhiệt và tự di chuyển. Theo dõi trực tiếp máy cho đến khi xong.',
        'Đã kiểm tra, chạy toàn hệ thống',
      ))
    )
      return;
    const result = await api('/printer/commands', {
      method: 'POST',
      body: { type: 'systemCheck', confirmed: true },
    });
    toast(result.message);
    await loadState();
  } catch (error) {
    $('#health-error').textContent = error.message;
    throw error;
  } finally {
    UI.calibrating = false;
    renderHealth();
  }
}
async function calibratePrinter() {
  if (UI.calibrating) return;
  const reason = calibrationReadiness();
  if (reason) throw new Error(reason);
  const options = Object.fromEntries(
    ['bedLeveling', 'vibration', 'motorNoise'].map((key) => [
      key,
      $(`#calibration-${key}`).checked,
    ]),
  );
  if (!Object.values(options).some(Boolean)) throw new Error('Chọn ít nhất một mục hiệu chuẩn.');
  UI.calibrating = true;
  renderHealth();
  try {
    if (
      !(await confirmAction(
        'Chạy hiệu chuẩn máy in?',
        'Máy có thể gia nhiệt và di chuyển đầu in/bàn in. Dọn sạch bàn, lắp bàn in đúng vị trí và kiểm tra vùng chuyển động. Theo dõi trực tiếp máy trong khi chạy.',
        'Đã kiểm tra, chạy hiệu chuẩn',
      ))
    )
      return;
    const result = await api('/printer/commands', {
      method: 'POST',
      body: { type: 'calibration', confirmed: true, options },
    });
    toast(result.message);
    await loadState();
  } catch (error) {
    $('#health-error').textContent = error.message;
    throw error;
  } finally {
    UI.calibrating = false;
    renderHealth();
  }
}
function spools(unit) {
  return Array.from({ length: 4 }, (_, index) => {
    const tray = unit?.trays?.find((item) => Number(item.id) === index);
    const empty = !tray?.type;
    return `<div class="spool-slot"><div class="spool-ring ${empty ? 'empty' : ''}"${empty ? '' : ` style="--spool-color:${tray.color}"`}></div><div class="slot-number">A${index + 1}</div><div class="slot-name">${escape(empty ? 'Chưa có vật liệu' : tray.name)}</div><div class="slot-remaining">${empty ? '—' : tray.remaining === null ? 'Chưa rõ lượng còn lại' : `Còn ${number(tray.remaining)}%`}</div></div>`;
  }).join('');
}
function timelapseBytes(bytes = 0) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function renderTimelapse() {
  const data = UI.timelapse;
  const active = data.active;
  const labels = {
    recording: 'Đang ghi',
    stopping: 'Đang dừng',
    rendering: 'Đang ghép video',
    ready: 'Sẵn sàng',
    failed: 'Có lỗi',
    interrupted: 'Bị gián đoạn',
  };
  const key = JSON.stringify(data.settings);
  if (key !== UI.timelapseSettingsKey) {
    UI.timelapseSettingsKey = key;
    $('#timelapse-auto').checked = Boolean(data.settings?.auto);
    $('#timelapse-interval').value = String(data.settings?.interval || 10);
    $('#timelapse-fps').value = String(data.settings?.fps || 24);
  }
  $('#timelapse-status').textContent = active
    ? `${labels[active.status] || active.status} trên server · ${active.name} · ${number(active.frames)} ảnh · ${active.mode === 'auto' ? 'Tự động theo bản in' : 'Ghi thủ công'}`
    : data.settings?.auto
      ? 'Tự ghi đang bật. Server sẽ bắt đầu khi nhận được trạng thái bản in.'
      : 'Chưa ghi timelapse. Bấm bắt đầu hoặc bật tự ghi theo bản in.';
  $('#timelapse-detail').textContent = active
    ? active.lastError
      ? `Ảnh gần nhất bị lỗi: ${active.lastError}`
      : active.message || 'Đóng trình duyệt vẫn tiếp tục ghi.'
    : data.autoError || 'Video lưu trên server. Đóng trang hoặc tắt xem trực tiếp không dừng ghi.';
  $('#timelapse-start').disabled = UI.timelapseBusy || data.busy || !UI.settings.configured;
  $('#timelapse-stop').hidden = !active || active.status !== 'recording';
  $('#timelapse-stop').disabled = UI.timelapseBusy;
  $('#timelapse-storage').textContent =
    `Đã dùng ${timelapseBytes(data.usedBytes)}${data.limits ? ` / ${timelapseBytes(data.limits.maxStorageBytes)}` : ''} · ${(data.clips || []).length} bản ghi`;
  $('#timelapse-indicator').hidden = !active;
  $('#timelapse-indicator').textContent =
    active?.status === 'recording' ? 'ĐANG GHI TIMELAPSE' : 'ĐANG GHÉP TIMELAPSE';
  const html =
    (data.clips || [])
      .map((clip) => {
        if (!/^[a-f0-9]{32}$/.test(clip.id)) return '';
        return `<article class="card timelapse-clip"><div class="timelapse-clip-head"><div class="timelapse-thumb">${icon('camera')}</div><span class="health-tag ${clip.status === 'failed' ? 'health-error' : clip.status === 'ready' ? 'health-ok' : 'health-warning'}">${escape(labels[clip.status] || clip.status)}</span></div><h3>${escape(clip.name)}</h3><p class="field-help">${new Date(clip.startedAt).toLocaleString('vi-VN')} · ${clip.mode === 'auto' ? 'Tự động' : 'Thủ công'}</p><p class="timelapse-meta">${number(clip.frames)} ảnh · ${clip.interval}s/ảnh · ${clip.fps} fps${clip.status === 'ready' ? ` · ${(clip.frames / clip.fps).toFixed(1)} giây video · ${timelapseBytes(clip.size)}` : ''}</p>${clip.status !== 'ready' ? `<p class="field-help">${escape(clip.message || '')}</p>` : ''}${clip.missedFrames ? `<p class="field-help">${number(clip.missedFrames)} lần chụp bị lỡ.</p>` : ''}<div class="timelapse-actions">${clip.status === 'ready' ? `<button class="button secondary compact" data-timelapse-action="play" data-id="${clip.id}">${icon('play')}Xem video</button><a class="button secondary compact" href="${API_BASE}/timelapses/${clip.id}/video?download=1">Tải MP4</a>` : ['failed', 'interrupted'].includes(clip.status) && clip.frames >= 2 ? `<button class="button secondary compact" data-timelapse-action="render" data-id="${clip.id}" ${data.busy || UI.timelapseBusy ? 'disabled' : ''}>Ghép lại</button>` : ''}<button class="text-button" data-timelapse-action="delete" data-id="${clip.id}" ${clip.id === active?.id || UI.timelapseBusy ? 'disabled' : ''}>Xóa</button></div></article>`;
      })
      .join('') ||
    '<section class="card timelapse-empty">Chưa có bản ghi. Timelapse đầu tiên sẽ xuất hiện tại đây.</section>';
  if ($('#timelapse-list').innerHTML !== html) $('#timelapse-list').innerHTML = html;
}
function timelapseOptions() {
  return {
    interval: Number($('#timelapse-interval').value),
    fps: Number($('#timelapse-fps').value),
  };
}
async function timelapseAction(fn) {
  if (UI.timelapseBusy) return;
  UI.timelapseBusy = true;
  $('#timelapse-error').textContent = '';
  renderTimelapse();
  try {
    await fn();
    await loadState();
  } catch (error) {
    $('#timelapse-error').textContent = error.message;
    throw error;
  } finally {
    UI.timelapseBusy = false;
    renderTimelapse();
  }
}
async function startTimelapse() {
  return timelapseAction(async () => {
    await api('/timelapses/start', {
      method: 'POST',
      body: { name: $('#timelapse-name').value, ...timelapseOptions() },
    });
    toast('Đã bắt đầu ghi timelapse trên server.');
  });
}
async function stopTimelapse() {
  const id = UI.timelapse.active?.id;
  if (!id) return;
  return timelapseAction(async () => {
    await api(`/timelapses/${id}/stop`, { method: 'POST', body: {} });
    toast('Đã dừng ghi. Đang ghép video MP4 từ các ảnh đã chụp.');
  });
}
function usbBytes(size) {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}
function usbFileInUse(entry) {
  if (!['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'].includes(UI.printer.status)) return false;
  const haystack = `${UI.printer.task || ''}\n${UI.printer.activeFile || ''}`.toLowerCase();
  return [entry?.name, entry?.label]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .some((value) => haystack.includes(value.toLowerCase()));
}
function renderUsb() {
  const data = UI.usb;
  $('#usb-path').hidden = !data.loaded;
  $('#usb-refresh').disabled = UI.usbBusy;
  if (!data.loaded) {
    $('#usb-path').innerHTML = '';
    $('#usb-list').innerHTML = '';
    return;
  }
  const parts = String(data.path || '/')
    .split('/')
    .filter(Boolean);
  const crumbs = [{ label: 'USB', path: '/' }];
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    crumbs.push({ label: part, path: current });
  }
  $('#usb-path').innerHTML = crumbs
    .map((crumb, index) => {
      const encoded = escape(encodeURIComponent(crumb.path));
      const label = escape(crumb.label);
      return index === crumbs.length - 1
        ? `<span>${label}</span>`
        : `<button type="button" data-usb-open="${encoded}">${label}</button><span aria-hidden="true">/</span>`;
    })
    .join('');
  const html = data.entries.length
    ? data.entries
        .map((entry) => {
          const encoded = escape(encodeURIComponent(entry.path));
          if (entry.type === 'directory')
            return `<article class="card usb-row"><button type="button" class="text-button" data-usb-open="${encoded}">${escape(entry.name)}</button><span class="field-help">Thư mục</span></article>`;
          const when = entry.modifiedAt
            ? ` · ${new Date(entry.modifiedAt).toLocaleString('vi-VN')}`
            : '';
          const named = entry.label ? `${escape(entry.name)} · ` : '';
          const note =
            entry.type === 'file'
              ? `${named}${usbBytes(entry.size)}${when}`
              : 'Không xóa được mục này';
          const locked = entry.type === 'file' && (UI.printer.jobPending || usbFileInUse(entry));
          const remove =
            entry.type === 'file'
              ? `<button type="button" class="text-button" data-usb-delete="${encoded}" ${locked || UI.usbBusy ? 'disabled' : ''}>Xóa</button>`
              : '';
          return `<article class="card usb-row"><div><h3>${escape(entry.label || entry.name)}</h3><p class="field-help">${note}</p></div>${remove}</article>`;
        })
        .join('')
    : '<section class="card usb-empty">Thư mục này không có tệp.</section>';
  if ($('#usb-list').innerHTML !== html) $('#usb-list').innerHTML = html;
  if (!data.loaded || UI.usbBusy) return;
  const hold =
    ['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'].includes(UI.printer.status) && UI.printer.task
      ? ` Máy đang in “${UI.printer.task}”. Chỉ tệp của bản in này bị giữ lại.`
      : '';
  const sdcard =
    UI.printer.sdcard === true
      ? ''
      : ' Máy vẫn có thể báo chưa nhận thẻ nhớ; danh sách này đọc trực tiếp từ USB.';
  $('#usb-status').textContent =
    `Đang xem ${data.path}. ${data.entries.length} mục.${hold}${sdcard}`;
}
async function loadUsb(path = UI.usb.path || '/') {
  if (UI.usbBusy) return;
  UI.usbBusy = true;
  $('#usb-error').textContent = '';
  $('#usb-status').textContent = 'Đang đọc USB máy in…';
  renderUsb();
  try {
    const listing = await api(`/printer/storage?path=${encodeURIComponent(path)}`, {
      timeout: 60000,
    });
    UI.usb = { ...listing, loaded: true };
    const count = UI.usb.entries.length;
    const sdcard =
      UI.printer.sdcard === true
        ? ''
        : ' Máy vẫn có thể báo chưa nhận thẻ nhớ; danh sách này đọc trực tiếp từ USB.';
    $('#usb-status').textContent = UI.usb.truncated
      ? `Đang xem ${UI.usb.path}. Có hơn ${count} mục, chỉ hiện ${count} mục đầu.${sdcard}`
      : `Đang xem ${UI.usb.path}. ${count} mục.${sdcard}`;
  } catch (error) {
    $('#usb-error').textContent = error.message;
  } finally {
    UI.usbBusy = false;
    renderUsb();
  }
}
async function deleteUsb(filePath) {
  if (UI.usbBusy) return;
  const entry = UI.usb.entries.find((item) => item.path === filePath);
  if (UI.printer.jobPending) {
    $('#usb-error').textContent = 'Đang gửi tệp in. Đợi xong rồi mới xóa tệp trên USB.';
    return;
  }
  if (usbFileInUse(entry)) {
    $('#usb-error').textContent = 'Tệp này đang được bản in dùng. Đợi máy in xong rồi mới xóa.';
    return;
  }
  if (
    !(await confirmAction(
      'Xóa tệp trên USB?',
      `Tệp “${entry?.label || entry?.name || filePath}” sẽ bị xóa khỏi USB máy in. Không khôi phục được từ app.`,
      'Xóa trên USB',
      true,
    ))
  )
    return;
  UI.usbBusy = true;
  $('#usb-error').textContent = '';
  renderUsb();
  try {
    await api('/printer/storage', {
      method: 'DELETE',
      timeout: 60000,
      body: { path: filePath, confirmed: true },
    });
    toast('Đã xóa tệp trên USB.');
    const listing = await api(`/printer/storage?path=${encodeURIComponent(UI.usb.path || '/')}`, {
      timeout: 60000,
    });
    UI.usb = { ...listing, loaded: true };
    $('#usb-status').textContent = `Đã xóa. Đang xem ${UI.usb.path}. ${UI.usb.entries.length} mục.`;
  } catch (error) {
    $('#usb-error').textContent = error.message;
  } finally {
    UI.usbBusy = false;
    renderUsb();
  }
}
function renderMaterials() {
  const ams = UI.printer.ams || [];
  $('#ams-overview').innerHTML = spools(ams[0]);
  $('#ams-humidity').innerHTML =
    `Độ ẩm <strong>${ams[0]?.humidity === null || ams[0]?.humidity === undefined ? '—' : `${number(ams[0].humidity)}%`}</strong>`;
  $('#ams-full').innerHTML = ams.length
    ? ams
        .map(
          (unit) =>
            `<section class="card"><div class="card-top"><h2>AMS ${Number(unit.id) + 1}</h2><span class="pill">${unit.humidity === null ? 'Độ ẩm chưa xác định' : `Độ ẩm ${number(unit.humidity)}%`}</span></div><div class="ams-overview">${spools(unit)}</div><div class="ams-footer"><span>Nhiệt độ <strong>${number(unit.temperature)}°C</strong></span><span>VẬT LIỆU ĐỌC TỪ MÁY IN</span></div></section>`,
        )
        .join('')
    : `<section class="card empty-materials"><div class="card-top"><h2>Hệ thống AMS</h2><span class="pill">Chưa có dữ liệu</span></div><div class="ams-overview">${spools(null)}</div><p>Kết nối P2S để đọc vật liệu từ AMS.</p></section>`;
}
function switchPage(page) {
  const titles = {
    overview: ['Tổng quan', 'Mọi thông tin về bản in, trong một không gian.'],
    files: ['Tệp in', 'Từ ý tưởng đến bản in tiếp theo.'],
    materials: ['Vật liệu', 'Mỗi cuộn vật liệu, một khả năng mới.'],
    health: ['Lỗi & kiểm tra', 'Đọc cảnh báo, kiểm tra kết nối và hiệu chuẩn máy in.'],
    timelapse: ['Timelapse', 'Giữ lại quá trình từ lớp in đầu tiên đến thành phẩm.'],
    usb: ['USB', 'Tệp đang nằm trên USB của máy in.'],
  };
  if (!titles[page]) return;
  UI.page = page;
  $$('.page-content').forEach((section) => {
    section.hidden = section.id !== `page-${page}`;
  });
  $$('.nav-item[data-page]').forEach((button) =>
    button.classList.toggle('active', button.dataset.page === page),
  );
  $('#page-title').innerHTML = `${titles[page][0]}<span>.</span>`;
  $('#breadcrumb-page').textContent = titles[page][0];
  $('#page-subtitle').textContent = titles[page][1];
  $('#heading-action').innerHTML =
    page === 'files'
      ? `${icon('plus')} Thêm tệp in`
      : page === 'usb'
        ? `${icon('refresh')} Kiểm tra lại`
        : `${icon('settings')} Kết nối máy in`;
  if (page !== 'overview') cameraClose();
  if (page === 'usb' && !UI.usb.loaded) loadUsb(UI.usb.path || '/');
}
function openSettings() {
  const form = $('#settings-form');
  for (const name of ['name', 'host', 'serial'])
    form.elements[name].value = UI.settings[name] || (name === 'name' ? 'P2S Combo' : '');
  form.elements.accessCode.value = '';
  form.elements.accessCode.required = !UI.settings.hasAccessCode;
  $('#access-code-help').textContent = UI.settings.hasAccessCode
    ? 'Đã lưu Access Code. Để trống để giữ mã cũ; đổi IP hoặc serial cần nhập lại mã.'
    : 'Chỉ lưu ở server, không hiển thị lại trên web.';
  $('#settings-error').textContent = '';
  $('#settings-dialog').showModal();
}
function confirmAction(title, description, label = 'Xác nhận', danger = false) {
  return new Promise((resolve) => {
    const dialog = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-description').textContent = description;
    $('#confirm-ok').textContent = label;
    $('#confirm-ok').className = `button ${danger ? 'danger' : 'primary'}`;
    const done = (value) => {
      $('#confirm-ok').onclick = null;
      $('#confirm-cancel').onclick = null;
      dialog.removeEventListener('close', closed);
      dialog.close();
      resolve(value);
    };
    const closed = () => done(false);
    $('#confirm-ok').onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    dialog.addEventListener('close', closed, { once: true });
    dialog.showModal();
  });
}
async function command(type, value, confirmed) {
  if (!UI.printer.fresh) throw new Error('Cần kết nối và dữ liệu mới từ máy in.');
  const result = await api('/printer/commands', {
    method: 'POST',
    body: { type, value, confirmed },
  });
  toast(result.message);
  await loadState();
}
function cameraClose() {
  UI.camera = false;
  const image = $('#camera-image');
  if (!image) return;
  image.removeAttribute('src');
  image.hidden = true;
  $('#camera-empty').hidden = false;
  $('#camera-close').hidden = true;
  $('#camera-badge').textContent = 'ĐANG TẮT';
  $('#camera-dot').classList.add('muted-dot');
  $('#camera-open').disabled = !UI.settings.configured;
  $('#camera-open').innerHTML = `Mở camera ${icon('arrow')}`;
}
async function cameraOpen() {
  if (!UI.settings.configured) return openSettings();
  $('#camera-open').disabled = true;
  $('#camera-open').textContent = 'Đang mở…';
  $('#camera-help').textContent = 'Đang đợi hình ảnh từ máy in…';
  try {
    const response = await fetch(`${API_BASE}/camera/snapshot`, {
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Không mở được camera.');
    }
    if (!response.headers.get('content-type')?.startsWith('image/'))
      throw new Error('Camera chưa trả về hình ảnh.');
    await response.body.cancel();
    UI.camera = true;
    $('#camera-image').src = `${API_BASE}/camera/stream?t=${Date.now()}`;
    $('#camera-image').hidden = false;
    $('#camera-empty').hidden = true;
    $('#camera-close').hidden = false;
    $('#camera-badge').textContent = 'TRỰC TIẾP';
    $('#camera-dot').classList.remove('muted-dot');
  } catch (error) {
    cameraClose();
    $('#camera-help').textContent = error.message;
    throw error;
  }
}
async function loadProjects() {
  const [projects, folders] = await Promise.all([api('/projects'), api('/projects/folders')]);
  UI.projects = projects.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
  UI.folders = folders;
  if (UI.folderId && !folders.some((folder) => folder.id === UI.folderId)) UI.folderId = '';
  renderLibrary();
}
function folderOptions(selected = '') {
  return [{ id: '', name: 'Thư viện gốc' }, ...UI.folders]
    .map(
      (folder) =>
        `<option value="${escape(folder.id)}" ${folder.id === selected ? 'selected' : ''}>${escape(folder.name)}</option>`,
    )
    .join('');
}
function openLibraryFolder(id) {
  UI.folderId = id;
  renderLibrary();
}
function renderLibrary() {
  const projects = UI.projects.filter((project) => (project.folderId || '') === UI.folderId);
  const current = UI.folders.find((folder) => folder.id === UI.folderId);
  $('#file-count').textContent = UI.projects.length;
  $('#library-title').textContent = current?.name || 'Thư viện gốc';
  $('#library-summary').textContent =
    `${projects.length} tệp · ${UI.projects.length} tệp toàn thư viện`;
  $('#upload-folder').innerHTML = folderOptions(UI.folderId);
  $('#upload-folder').value = UI.folderId;
  $('#library-folders').innerHTML = [{ id: '', name: 'Thư viện gốc' }, ...UI.folders]
    .map((folder) => {
      const count = UI.projects.filter((project) => (project.folderId || '') === folder.id).length;
      return `<button type="button" class="card library-folder" data-library-folder="${escape(folder.id)}" data-drop-folder="${escape(folder.id)}" aria-pressed="${folder.id === UI.folderId}">${icon('folder')}<span><strong>${escape(folder.name)}</strong><small>${count} tệp</small></span></button>`;
    })
    .join('');
  $('#projects-list').innerHTML = projects.length
    ? projects
        .map(
          (project) =>
            `<article class="card project-card" draggable="true" data-drag-project="${project.id}"><div class="project-art"><img src="${API_BASE}/projects/${project.id}/preview" draggable="false" alt="Xem trước ${escape(project.name)}" onerror="this.remove()" />${icon('cube')}</div><h3 title="${escape(project.name)}">${escape(project.name)}</h3><div class="project-meta"><span>${project.plates.length} plate</span><span>${(project.size / 1024 ** 2).toFixed(1)} MB</span><span>${new Date(project.addedAt).toLocaleDateString('vi-VN')}</span></div><div class="project-actions"><button class="button secondary project-print" data-project="${project.id}" ${UI.queue.active ? 'disabled' : ''}>${icon('play')} In riêng</button><button class="text-button" data-delete="${project.id}">Xóa</button></div><label class="project-folder-select">Chuyển tới thư mục<select data-move-project="${project.id}">${folderOptions(project.folderId || '')}</select></label></article>`,
        )
        .join('')
    : `<div class="library-empty">${icon('file')}<h3>${current ? 'Thư mục chưa có tệp.' : 'Bản in tiếp theo bắt đầu ở đây.'}</h3><p>Kéo tệp vào thư mục phía trên hoặc chọn thư mục đích rồi bấm Thêm tệp in.</p></div>`;
  renderPrintControls();
  $$('.project-print').forEach((button) =>
    button.addEventListener('click', () => openPrint(button.dataset.project)),
  );
  $$('[data-delete]').forEach((button) =>
    button.addEventListener(
      'click',
      action(async () => {
        const project = UI.projects.find((item) => item.id === button.dataset.delete);
        if (
          await confirmAction(
            'Xóa tệp khỏi thư viện?',
            `Tệp “${project.name}” sẽ bị xóa khỏi server.`,
            'Xóa tệp',
            true,
          )
        ) {
          await api(`/projects/${project.id}`, { method: 'DELETE' });
          await loadProjects();
          toast('Đã xóa tệp khỏi thư viện.');
        }
      }),
    ),
  );
}
function canPrint() {
  return Boolean(
    UI.printer.fresh &&
      !UI.queue.active &&
      !UI.printer.jobPending &&
      !UI.printer.configPending &&
      !UI.printer.maintenance?.active &&
      ['IDLE', 'FINISH', 'FAILED'].includes(UI.printer.status) &&
      UI.printer.sdcard === true,
  );
}
function printReadiness() {
  const p = UI.printer;
  if (!p.fresh) return 'Đang chờ kết nối và dữ liệu mới từ máy in.';
  if (p.maintenance?.active)
    return 'Đang hiệu chuẩn hoặc chưa xác minh xong hiệu chuẩn. Kiểm tra máy trước khi in.';
  if (p.jobPending) return 'Đang gửi tác vụ in. Vui lòng đợi máy xác nhận.';
  if (p.configPending) return 'Đang cập nhật kết nối máy in.';
  if (!['IDLE', 'FINISH', 'FAILED'].includes(p.status))
    return 'Máy đang bận. Đợi bản in hiện tại kết thúc.';
  if (p.sdcard !== true)
    return 'Máy chưa nhận thẻ nhớ. Bố lắp/kiểm tra thẻ nhớ trên P2S rồi bấm in lại.';
  return '';
}
function renderPrintControls() {
  const reason = printReadiness();
  $('#print-readiness').textContent =
    reason || 'Sẵn sàng in. Bấm In tất cả để tự in lần lượt theo thứ tự bên dưới.';
  $('#print-readiness').classList.toggle('form-error', Boolean(reason));
  const locked = UI.queue.active || UI.queueSubmitting;
  $('#print-all-button').disabled = locked || !UI.projects.length;
  $('#print-all-button').innerHTML =
    `${icon('play')} ${locked ? 'Hàng đợi đang chạy…' : `In tất cả (${UI.projects.length} tệp)`}`;
  $$('.project-print').forEach((button) => {
    button.disabled = locked;
  });
  $$('[data-delete]').forEach((button) => {
    button.disabled = locked;
  });
  if ($('#print-dialog').open) {
    $('#print-form button[type=submit]').disabled = !canPrint();
    $('#print-error').textContent = UI.queue.active
      ? 'Hàng đợi đang chạy. Hủy hàng đợi trước khi in riêng.'
      : reason;
  }
  const queue = UI.queue;
  $('#queue-status').hidden = queue.status === 'idle';
  $('#queue-message').textContent = queue.message || '';
  $('#queue-progress').textContent =
    `${queue.completed || 0}/${queue.items.length} plate hoàn thành`;
  $('#cancel-queue-button').hidden = !queue.active;
  const labels = {
    pending: 'Chờ in',
    submitting: 'Đang gửi',
    awaiting_start: 'Chờ máy xác nhận',
    printing: 'Đang in',
    completed: 'Hoàn thành',
    failed: 'Lỗi',
    cancelled: 'Đã hủy',
  };
  $('#queue-items').innerHTML = queue.items
    .map(
      (item) =>
        `<li><span>${escape(item.name)} · Plate ${item.plate}</span><strong>${escape(labels[item.status] || item.status)}</strong></li>`,
    )
    .join('');
}
async function startPrintQueue() {
  if (UI.queueSubmitting || UI.queue.active) return;
  UI.queueSubmitting = true;
  $('#queue-error').textContent = '';
  renderPrintControls();
  try {
    UI.queue = await api('/projects/queue/start', { method: 'POST', body: { confirmed: true } });
    toast('Đã tạo hàng đợi. Máy sẽ in lần lượt từng tệp.');
    await loadState();
  } catch (error) {
    $('#queue-error').textContent = error.message;
    await loadState().catch(() => {});
  } finally {
    UI.queueSubmitting = false;
    renderPrintControls();
  }
}
async function uploadFile() {
  const files = [...($('#file-input').files || [])];
  return uploadFiles(files, $('#upload-folder').value || '');
}
async function uploadFiles(files, folderId) {
  if (!files.length) return;
  if (UI.uploadBusy) throw new Error('Đang tải tệp. Đợi hoàn tất trước khi thêm tệp khác.');
  UI.uploadBusy = true;
  const failures = [];
  let added = 0;
  try {
    $('#upload-button').disabled = true;
    for (const [index, file] of files.entries()) {
      $('#upload-button').textContent =
        files.length === 1 ? 'Đang tải tệp…' : `Đang tải ${index + 1}/${files.length}…`;
      try {
        if (!file.name.toLowerCase().endsWith('.gcode.3mf'))
          throw new Error('Chỉ nhận .gcode.3mf đã slice cho P2S.');
        if (file.size > 200 * 1024 ** 2) throw new Error('Tệp vượt quá 200 MB.');
        const form = new FormData();
        form.append('file', file);
        form.append('folderId', folderId);
        await api('/projects', { method: 'POST', body: form, timeout: 180000 });
        added += 1;
      } catch (error) {
        failures.push(`${file.name}: ${error.message}`);
      }
    }
    if (added) {
      await loadProjects();
      toast(added === 1 ? 'Đã thêm tệp vào thư viện.' : `Đã thêm ${added} tệp vào thư viện.`);
    }
    if (failures.length) throw new Error(failures.join('\n'));
  } finally {
    UI.uploadBusy = false;
    $('#upload-button').disabled = false;
    $('#upload-button').innerHTML = `${icon('plus')} Thêm tệp in`;
    $('#file-input').value = '';
  }
}
async function moveProject(id, folderId) {
  const project = UI.projects.find((item) => item.id === id);
  if (!project || (project.folderId || '') === folderId) return;
  await api(`/projects/${id}/folder`, { method: 'PATCH', body: { folderId: folderId || null } });
  await loadProjects();
  toast('Đã chuyển tệp tới thư mục.');
}
async function handleLibraryDrop(event) {
  const target = event.target.closest('[data-drop-folder]');
  if (!target) return;
  event.preventDefault();
  target.classList.remove('drag-over');
  const folderId = target.dataset.dropFolder;
  const files = [...(event.dataTransfer.files || [])];
  if (files.length) {
    await uploadFiles(files, folderId);
    return;
  }
  const id = event.dataTransfer.getData('application/x-p2s-project');
  if (id) await moveProject(id, folderId);
}
async function createLibraryFolder(event) {
  event.preventDefault();
  const button = $('#folder-form button[type=submit]');
  button.disabled = true;
  $('#folder-error').textContent = '';
  try {
    const folder = await api('/projects/folders', {
      method: 'POST',
      body: { name: $('#folder-name').value },
    });
    UI.folderId = folder.id;
    await loadProjects();
    $('#folder-dialog').close();
    toast('Đã tạo thư mục.');
  } catch (error) {
    $('#folder-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
function openPrint(id) {
  const project = UI.projects.find((item) => item.id === id);
  if (!project) return;
  UI.selectedProject = project;
  $('#print-form').reset();
  $('#print-error').textContent = printReadiness();
  $('#print-form button[type=submit]').disabled = !canPrint();
  $('#print-project-name').textContent = project.name;
  const preview = $('#print-preview');
  preview.hidden = true;
  preview.alt = `Xem trước ${project.name}`;
  preview.onload = () => {
    preview.hidden = false;
  };
  preview.onerror = () => {
    preview.hidden = true;
  };
  preview.src = `${API_BASE}/projects/${project.id}/preview`;
  $('#print-plate').innerHTML = project.plates
    .map(
      (plate) =>
        `<option value="${plate.number}">Plate ${plate.number}${plate.seconds ? ` · ${duration(plate.seconds / 60)}` : ''}</option>`,
    )
    .join('');
  if (!(UI.printer.ams || []).length) $('#print-source').value = 'external';
  renderMapping();
  $('#print-dialog').showModal();
}
function materialColor(value) {
  return /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(value || '')
    ? value.slice(0, 7).toUpperCase()
    : null;
}
function materialColorLabel(value) {
  const color = materialColor(value);
  if (!color) return 'Chưa rõ màu';
  const names = {
    '#FFFFFF': 'Trắng',
    '#000000': 'Đen',
    '#808080': 'Xám',
    '#E8C4B0': 'Da',
    '#F72323': 'Đỏ',
  };
  return `${names[color] || 'Màu'} (${color})`;
}
function readPrintMapping(plate) {
  const mapping = Array(plate.filamentCount).fill(-1);
  if ($('#print-source').value !== 'ams') return mapping;
  for (const filament of plate.filaments) {
    const value = $(`[data-filament="${filament.id}"]`)?.value;
    if (!/^\d+$/.test(value ?? '') || Number(value) > 253)
      throw new Error(`Chọn khay in cho filament ${filament.id}.`);
    mapping[filament.id - 1] = Number(value);
  }
  return mapping;
}
function updateMappingSummary() {
  const summary = $('#print-mapping-summary');
  if ($('#print-source').value !== 'ams') {
    summary.textContent = 'Bản in này dùng cuộn ngoài.';
    return;
  }
  const plate = UI.selectedProject?.plates.find(
    (item) => item.number === Number($('#print-plate').value),
  );
  if (!plate) return;
  summary.textContent = plate.filaments
    .map((filament) => {
      const value = $(`[data-filament="${filament.id}"]`)?.value;
      if (!/^\d+$/.test(value ?? '')) return `Filament ${filament.id}: chưa chọn khay in.`;
      const selected = Number(value);
      const unit = (UI.printer.ams || []).find(
        (item) => Number(item.id) === Math.floor(selected / 4),
      );
      const tray = unit?.trays.find((item) => Number(item.id) === selected % 4);
      const label = `AMS ${Math.floor(selected / 4) + 1} · A${(selected % 4) + 1}`;
      if (!tray) return `Filament ${filament.id}: không tìm thấy ${label} trong dữ liệu máy.`;
      if (!tray.type)
        return `Filament ${filament.id} → ${label} · Máy chưa khai báo vật liệu. Kiểm tra đã nạp đúng cuộn ${filament.type} trước khi gửi in.`;
      const color = materialColor(filament.color);
      const different = color && materialColor(tray.color) !== color;
      return `Filament ${filament.id} → AMS ${Math.floor(selected / 4) + 1} · A${(selected % 4) + 1} · ${tray.type} · ${materialColorLabel(tray.color)}${different ? ' (khác màu trong tệp; sẽ dùng cuộn ở khay đã chọn)' : ''}.`;
    })
    .join(' ');
}
function choosePrintTray(event) {
  const button = event.target.closest('[data-print-tray]');
  if (!button || button.disabled) return;
  const filament = button.dataset.trayFilament;
  const input = $(`[data-filament="${filament}"]`);
  if (!input) return;
  input.value = button.dataset.printTray;
  $$(`[data-tray-filament="${filament}"]`).forEach((choice) => {
    choice.setAttribute('aria-pressed', String(choice === button));
  });
  updateMappingSummary();
}
function renderMapping() {
  const plate = UI.selectedProject?.plates.find(
    (item) => item.number === Number($('#print-plate').value),
  );
  if (!plate) return;
  const useAms = $('#print-source').value === 'ams';
  const automatic = $('#print-mapping-mode').value === 'auto';
  $('#print-mapping-mode-field').hidden = !useAms;
  const trays = (UI.printer.ams || []).flatMap((unit) =>
    unit.trays.map((tray) => ({
      value: Number(unit.id) * 4 + Number(tray.id),
      label: `AMS ${Number(unit.id) + 1} · A${Number(tray.id) + 1}`,
      type: tray.type,
      color: materialColor(tray.color),
    })),
  );
  const namedSlot = UI.selectedProject.name.match(/(?:^|[-_\s])AMS(\d+)(?:$|[-_\s])/i);
  $('#print-mapping').innerHTML = useAms
    ? plate.filaments
        .map((filament) => {
          const color = materialColor(filament.color);
          const sameMaterial = (tray) =>
            Boolean(tray.type) && tray.type.toUpperCase() === filament.type.toUpperCase();
          const compatible = (tray) => sameMaterial(tray) && (!color || tray.color === color);
          const requested =
            namedSlot && plate.filaments.length === 1 ? Number(namedSlot[1]) - 1 : null;
          const candidates = color
            ? trays.filter(
                (tray) => compatible(tray) && (requested === null || tray.value === requested),
              )
            : [];
          const selected = automatic && candidates.length === 1 ? candidates[0] : null;
          const requestedTray = trays.find((tray) => tray.value === requested);
          let hint = selected
            ? `Gợi ý theo màu và vật liệu: ${selected.label}.`
            : candidates.length > 1
              ? 'Có nhiều khay cùng màu và vật liệu; chọn khay muốn dùng.'
              : color
                ? `Chưa có khay khớp ${filament.type} · ${materialColorLabel(color)}. Kiểm tra khai báo vật liệu trên máy in.`
                : 'Tệp chưa có màu xác định; chọn khay theo cuộn thực tế.';
          if (requested !== null && !requestedTray?.type)
            hint = `AMS ${Math.floor(requested / 4) + 1} · A${(requested % 4) + 1} chưa khai báo vật liệu. Khai báo ${filament.type} · ${materialColorLabel(color)} cho khay này trên máy in.`;
          else if (requestedTray && !compatible(requestedTray))
            hint = `${requestedTray.label} trong tên tệp không khớp màu hoặc loại nhựa; kiểm tra cuộn thực tế trước khi chọn khay.`;
          if (!automatic)
            hint = `Bấm một nút A1, A2, A3 hoặc A4 để chọn khay in. Kiểm tra đã nạp đúng cuộn ${filament.type} vào khay đã chọn.`;
          const controls = automatic
            ? `<select data-filament="${filament.id}" aria-label="Chọn khay in cho filament ${filament.id}" required><option value="">Chọn khay AMS đúng màu và vật liệu</option>${trays.map((tray) => `<option value="${tray.value}" ${selected?.value === tray.value ? 'selected' : ''} ${compatible(tray) ? '' : 'disabled'}>${escape(`${tray.label} · ${tray.type ? `${tray.type} · ${materialColorLabel(tray.color)}` : 'Chưa khai báo vật liệu'}`)}</option>`).join('')}</select>`
            : `<input type="hidden" data-filament="${filament.id}" value="" /><div class="tray-options" role="group" aria-label="Khay in cho filament ${filament.id}">${trays.map((tray) => `<button type="button" class="tray-choice" data-print-tray="${tray.value}" data-tray-filament="${filament.id}" aria-pressed="false" aria-label="Chọn khay A${(tray.value % 4) + 1} · AMS ${Math.floor(tray.value / 4) + 1}" ${!tray.type || sameMaterial(tray) ? '' : 'disabled'}><strong>A${(tray.value % 4) + 1}</strong><span>AMS ${Math.floor(tray.value / 4) + 1}</span><span>${escape(tray.type || 'Chưa khai báo')}</span>${tray.type ? `<span>${escape(materialColorLabel(tray.color))}</span>` : ''}</button>`).join('')}</div>`;
          return `<div class="tray-picker"><span>Chọn khay in · Filament ${filament.id}</span><span class="field-help">${escape(filament.type)}${filament.grams ? ` · ${filament.grams} g` : ''} · ${color ? `<i class="tiny-dot" style="background:${color}"></i> ` : ''}Màu trong tệp: ${escape(materialColorLabel(color))}</span>${controls}<span class="field-help">${escape(hint)}</span></div>`;
        })
        .join('')
    : '<p class="field-help">Đảm bảo cuộn ngoài đúng loại vật liệu đã slice. Plate nhiều vật liệu cần sử dụng AMS.</p>';
  updateMappingSummary();
}

$('#today').textContent = new Date().toLocaleDateString('vi-VN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-form button[type=submit]');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/auth/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    await showApp();
  } catch (error) {
    $('#login-error').textContent = error.message || 'Không kết nối được server.';
  } finally {
    button.disabled = false;
  }
});
$('#logout').addEventListener(
  'click',
  action(async () => {
    await api('/auth/logout', { method: 'POST', body: {} });
    showLogin();
  }),
);
$$('[data-page]').forEach((button) =>
  button.addEventListener('click', () => switchPage(button.dataset.page)),
);
$$('[data-go]').forEach((button) =>
  button.addEventListener('click', () => switchPage(button.dataset.go)),
);
$$('[data-close]').forEach((button) =>
  button.addEventListener('click', () => $(`#${button.dataset.close}`).close()),
);
$('#heading-action').addEventListener(
  'click',
  action(() => {
    if (UI.page === 'files') {
      if (UI.uploadBusy) return;
      $('#file-input').click();
      return;
    }
    if (UI.page === 'usb') return loadUsb(UI.usb.path || '/');
    openSettings();
  }),
);
$('#nav-settings').addEventListener('click', openSettings);
$('#sidebar-settings').addEventListener('click', openSettings);
$('#banner-action').addEventListener('click', () => openSettings());
$('#diagnostics-run').addEventListener('click', action(runDiagnostics));
$('#system-check').addEventListener('click', action(runSystemCheck));
$('#calibration-form').addEventListener(
  'submit',
  action(async (event) => {
    event.preventDefault();
    $('#health-error').textContent = '';
    await calibratePrinter();
  }),
);
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#settings-form button[type=submit]');
  button.disabled = true;
  $('#settings-error').textContent = '';
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    UI.settings = await api('/printer/config', { method: 'PUT', body: values });
    event.target.elements.accessCode.value = '';
    cameraClose();
    $('#settings-dialog').close();
    toast('Đã lưu cấu hình. Đang thử kết nối máy in.');
    await loadState();
  } catch (error) {
    $('#settings-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$('#reconnect').addEventListener(
  'click',
  action(async () => {
    if (!UI.settings.configured) return openSettings();
    await api('/printer/reconnect', { method: 'POST', body: {} });
    toast('Đang thử kết nối lại máy in.');
    await loadState();
  }),
);
$('#pause-button').addEventListener(
  'click',
  action(() => command('pause')),
);
$('#resume-button').addEventListener(
  'click',
  action(() => command('resume')),
);
$('#stop-button').addEventListener(
  'click',
  action(async () => {
    if (
      await confirmAction(
        'Dừng bản in hiện tại?',
        'Tác vụ đang in sẽ bị hủy và không thể tiếp tục từ vị trí này.',
        'Dừng bản in',
        true,
      )
    )
      await command('stop', undefined, true);
  }),
);
$('#light-toggle').addEventListener(
  'click',
  action(() => command('light', !UI.printer.light)),
);
$$('[data-speed]').forEach((button) =>
  button.addEventListener(
    'click',
    action(async () => {
      const value = Number(button.dataset.speed);
      if (
        value >= 3 &&
        !(await confirmAction(
          'Tăng tốc độ in?',
          'Tốc độ cao có thể ảnh hưởng chất lượng bản in và cần phù hợp với vật liệu.',
          'Đổi tốc độ',
        ))
      )
        return;
      await command('speed', value);
    }),
  ),
);
$$('[data-temperature]').forEach((button) =>
  button.addEventListener('click', () => {
    UI.temperature = button.dataset.temperature;
    const nozzle = UI.temperature === 'nozzle';
    $('#temperature-title').textContent = nozzle ? 'Nhiệt độ đầu phun' : 'Nhiệt độ bàn in';
    $('#temperature-value').max = nozzle ? '300' : '110';
    $('#temperature-value').value = UI.printer[UI.temperature]?.target ?? 0;
    $('#temperature-dialog').showModal();
  }),
);
$('#temperature-form').addEventListener(
  'submit',
  action(async (event) => {
    event.preventDefault();
    const value = Number($('#temperature-value').value);
    $('#temperature-dialog').close();
    if (
      value > 0 &&
      !(await confirmAction(
        'Xác nhận gia nhiệt?',
        `${UI.temperature === 'nozzle' ? 'Đầu phun' : 'Bàn in'} sẽ được đặt ở ${value}°C.`,
        'Đặt nhiệt độ',
      ))
    )
      return;
    await command(UI.temperature, value, true);
  }),
);
$('#camera-open').addEventListener('click', action(cameraOpen));
$('#timelapse-start').addEventListener('click', action(startTimelapse));
$('#timelapse-stop').addEventListener('click', action(stopTimelapse));
$('#timelapse-settings-form').addEventListener(
  'submit',
  action(async (event) => {
    event.preventDefault();
    await timelapseAction(async () => {
      UI.timelapse = await api('/timelapses/settings', {
        method: 'PUT',
        body: { auto: $('#timelapse-auto').checked, ...timelapseOptions() },
      });
      toast('Đã lưu thiết lập timelapse. Thay đổi thời gian áp dụng cho bản ghi tiếp theo.');
    });
  }),
);
$('#timelapse-list').addEventListener(
  'click',
  action(async (event) => {
    const button = event.target.closest('[data-timelapse-action]');
    if (!button || button.disabled) return;
    const { id, timelapseAction: type } = button.dataset;
    if (type === 'play') {
      const clip = UI.timelapse.clips.find((item) => item.id === id);
      $('#timelapse-player-title').textContent = clip?.name || 'Video timelapse';
      $('#timelapse-player').src = `${API_BASE}/timelapses/${id}/video`;
      $('#timelapse-player-dialog').showModal();
      return;
    }
    if (
      type === 'delete' &&
      !(await confirmAction(
        'Xóa bản ghi timelapse?',
        'Video và các ảnh của bản ghi này sẽ bị xóa khỏi server. Tải video trước nếu bố muốn giữ lại.',
        'Xóa bản ghi',
        true,
      ))
    )
      return;
    await timelapseAction(async () => {
      await api(`/timelapses/${id}${type === 'render' ? '/render' : ''}`, {
        method: type === 'render' ? 'POST' : 'DELETE',
        ...(type === 'render' ? { body: {} } : {}),
      });
    });
  }),
);
$('#timelapse-player-dialog').addEventListener('close', () => {
  const video = $('#timelapse-player');
  video.pause();
  video.removeAttribute('src');
  video.load();
});
$('#camera-close').addEventListener('click', cameraClose);
$('#camera-image').addEventListener('error', () => {
  if (UI.camera) {
    cameraClose();
    $('#camera-help').textContent = 'Luồng camera gián đoạn. Kiểm tra Liveview rồi thử lại.';
  }
});
$('#usb-refresh').addEventListener(
  'click',
  action(() => loadUsb(UI.usb.path || '/')),
);
$('#usb-path').addEventListener(
  'click',
  action(async (event) => {
    const button = event.target.closest('[data-usb-open]');
    if (!button) return;
    await loadUsb(decodeURIComponent(button.dataset.usbOpen));
  }),
);
$('#usb-list').addEventListener(
  'click',
  action(async (event) => {
    const open = event.target.closest('[data-usb-open]');
    if (open) {
      await loadUsb(decodeURIComponent(open.dataset.usbOpen));
      return;
    }
    const button = event.target.closest('[data-usb-delete]');
    if (!button || button.disabled) return;
    await deleteUsb(decodeURIComponent(button.dataset.usbDelete));
  }),
);
$('#print-all-button').addEventListener('click', action(startPrintQueue));
$('#cancel-queue-button').addEventListener(
  'click',
  action(async () => {
    UI.queue = await api('/projects/queue/cancel', { method: 'POST', body: {} });
    renderPrintControls();
    toast(UI.queue.message);
  }),
);
$('#upload-button').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', action(uploadFile));
$('#create-folder-button').addEventListener('click', () => {
  $('#folder-name').value = '';
  $('#folder-error').textContent = '';
  $('#folder-dialog').showModal();
  $('#folder-name').focus();
});
$('#folder-form').addEventListener('submit', createLibraryFolder);
$('#library-folders').addEventListener('click', (event) => {
  const button = event.target.closest('[data-library-folder]');
  if (button) openLibraryFolder(button.dataset.libraryFolder);
});
$('#projects-list').addEventListener(
  'change',
  action(async (event) => {
    const select = event.target.closest('[data-move-project]');
    if (!select) return;
    select.disabled = true;
    try {
      await moveProject(select.dataset.moveProject, select.value);
    } catch (error) {
      select.value =
        UI.projects.find((item) => item.id === select.dataset.moveProject)?.folderId || '';
      throw error;
    } finally {
      select.disabled = false;
    }
  }),
);
$('#projects-list').addEventListener('dragstart', (event) => {
  if (event.target.closest('button, select, label')) {
    event.preventDefault();
    return;
  }
  const card = event.target.closest('[data-drag-project]');
  if (!card) return;
  event.dataTransfer.setData('application/x-p2s-project', card.dataset.dragProject);
  event.dataTransfer.effectAllowed = 'move';
});
$('#library-folders').addEventListener('dragover', (event) => {
  const target = event.target.closest('[data-drop-folder]');
  if (!target) return;
  const types = [...event.dataTransfer.types];
  if (!types.includes('Files') && !types.includes('application/x-p2s-project')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
  target.classList.add('drag-over');
});
$('#library-folders').addEventListener('dragleave', (event) => {
  const target = event.target.closest('[data-drop-folder]');
  if (target && !target.contains(event.relatedTarget)) target.classList.remove('drag-over');
});
$('#library-folders').addEventListener('drop', action(handleLibraryDrop));
$('#projects-list').addEventListener('dragend', () => {
  $$('.drag-over').forEach((target) => target.classList.remove('drag-over'));
});
$('#print-plate').addEventListener('change', renderMapping);
$('#print-source').addEventListener('change', renderMapping);
$('#print-mapping-mode').addEventListener('change', renderMapping);
$('#print-mapping').addEventListener('change', updateMappingSummary);
$('#print-mapping').addEventListener('click', choosePrintTray);
$('#print-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#print-form button[type=submit]');
  button.disabled = true;
  $('#print-error').textContent = '';
  try {
    const plate = UI.selectedProject.plates.find(
      (item) => item.number === Number($('#print-plate').value),
    );
    const mapping = readPrintMapping(plate);
    button.textContent = 'Đang gửi tới máy in…';
    const result = await api(`/projects/${UI.selectedProject.id}/start`, {
      method: 'POST',
      timeout: 600000,
      body: {
        plate: plate.number,
        useAms: $('#print-source').value === 'ams',
        mappingMode:
          $('#print-source').value === 'ams' ? $('#print-mapping-mode').value : undefined,
        mapping,
        confirmed: $('#print-confirmation').checked,
      },
    });
    $('#print-dialog').close();
    switchPage('overview');
    toast(result.message);
    await loadState();
  } catch (error) {
    $('#print-error').textContent =
      error.name === 'TimeoutError'
        ? 'Quá thời gian chờ. Kiểm tra trạng thái máy trước khi gửi lại.'
        : error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon('play')} Gửi & bắt đầu in`;
    button.disabled = !canPrint();
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('#app-view').hidden) loadState().catch(() => {});
});
api('/auth/session')
  .then((session) => (session.authenticated ? showApp() : showLogin()))
  .catch(() => {
    showLogin();
    $('#login-error').textContent = 'Không kết nối được server. Tải lại trang để thử lại.';
  });
