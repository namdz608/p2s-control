const uint32 = (value) =>
  (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) &&
  Number.isInteger(Number(value)) &&
  Number(value) >= 0 &&
  Number(value) <= 0xffffffff;
const hex = (value) => Number(value).toString(16).toUpperCase().padStart(8, '0');
const levels = { 1: 'error', 2: 'error', 3: 'warning', 4: 'info' };
const modules = {
  3: 'Bộ điều khiển chuyển động',
  5: 'Bo mạch chính',
  7: 'AMS',
  8: 'Đầu in',
  12: 'Camera',
};

export const recoverableMaintenanceCodes = new Set(['0300400C', '0300110000020002']);

export function blockingMaintenanceFaults(state) {
  return printerFaults(state).filter(
    (fault) => fault.severity === 'error' && !recoverableMaintenanceCodes.has(fault.code),
  );
}

export function printerFaults(state) {
  const faults = [];
  if (uint32(state.printError) && Number(state.printError) !== 0)
    faults.push({
      kind: 'print',
      code: hex(state.printError),
      severity: 'error',
      title: 'Lỗi tác vụ in',
    });
  for (const item of state.hms || []) {
    if (!uint32(item?.attr) || !uint32(item?.code)) continue;
    const module = Math.floor(Number(item.attr) / 0x1000000);
    faults.push({
      kind: 'hms',
      code: hex(item.attr) + hex(item.code),
      severity: levels[Math.floor(Number(item.code) / 0x10000)] || 'warning',
      title: `HMS · ${modules[module] || 'Máy in'}`,
    });
  }
  return [
    ...new Map(
      faults.map((f) => [
        `${f.kind}:${f.code}`,
        {
          ...f,
          url: `https://e.bambulab.com/?e=${f.code}`,
          description: 'Xem hướng dẫn Bambu hoặc kiểm tra thông báo trên màn hình máy in.',
        },
      ]),
    ).values(),
  ];
}

export function inspectPrinter(state, faults = printerFaults(state)) {
  const fresh = state.fresh && state.healthFresh !== false;
  const checks = [];
  const add = (id, title, status, message) => checks.push({ id, title, status, message });
  add(
    'config',
    'Cấu hình máy in',
    state.connection === 'unconfigured' ? 'fail' : 'pass',
    state.connection === 'unconfigured'
      ? 'Thêm IP, serial và Access Code trong Kết nối máy in.'
      : 'Đã lưu cấu hình máy in.',
  );
  add(
    'connection',
    'Kết nối MQTT',
    state.connection === 'connected' ? 'pass' : 'fail',
    state.connection === 'connected'
      ? 'Đã kết nối đến máy in.'
      : state.message || 'Kiểm tra mạng, LAN Only và Developer Mode.',
  );
  add(
    'telemetry',
    'Dữ liệu từ máy in',
    fresh ? 'pass' : 'unknown',
    fresh
      ? 'Đang nhận trạng thái mới từ máy in.'
      : 'Chưa có dữ liệu mới; chưa thể kết luận tình trạng máy.',
  );
  add(
    'faults',
    'Lỗi in và cảnh báo HMS',
    !fresh
      ? 'unknown'
      : faults.some((f) => f.severity === 'error')
        ? 'fail'
        : faults.length
          ? 'warning'
          : 'pass',
    !fresh
      ? 'Các mã bên dưới là dữ liệu gần nhất, cần kiểm tra lại kết nối.'
      : faults.length
        ? `Máy đang báo ${faults.length} lỗi/cảnh báo.`
        : 'Không có lỗi in hoặc cảnh báo HMS trong dữ liệu hiện tại.',
  );
  add(
    'storage',
    'Thẻ nhớ',
    !state.fresh || state.fieldFresh?.sdcard === false
      ? 'unknown'
      : state.sdcard === true
        ? 'pass'
        : 'warning',
    state.sdcard === true
      ? 'Máy đã nhận thẻ nhớ.'
      : 'Chưa xác nhận thẻ nhớ. Kiểm tra thẻ trước khi gửi tệp in.',
  );
  add(
    'activity',
    'Tác vụ trên máy',
    !fresh
      ? 'unknown'
      : ['IDLE', 'FINISH', 'FAILED'].includes(state.status) && !state.maintenance?.active
        ? 'pass'
        : 'warning',
    state.maintenance?.active
      ? state.maintenance.message
      : ['IDLE', 'FINISH', 'FAILED'].includes(state.status)
        ? 'Máy đang rảnh.'
        : `Trạng thái hiện tại: ${state.status || 'UNKNOWN'}.`,
  );
  for (const [id, title] of [
    ['nozzle', 'Nhiệt độ đầu phun'],
    ['bed', 'Nhiệt độ bàn in'],
  ]) {
    const value = state[id]?.current;
    add(
      id,
      title,
      state.fresh &&
        state.fieldFresh?.[id === 'nozzle' ? 'nozzle_temper' : 'bed_temper'] !== false &&
        Number.isFinite(value)
        ? 'pass'
        : 'unknown',
      Number.isFinite(value)
        ? `${value}°C · chỉ đọc cảm biến, không gia nhiệt thử.`
        : 'Máy chưa cung cấp giá trị cảm biến.',
    );
  }
  return {
    status: !fresh
      ? 'unknown'
      : checks.some((c) => c.status === 'fail')
        ? 'error'
        : checks.some((c) => ['warning', 'unknown'].includes(c.status))
          ? 'warning'
          : 'ok',
    lastReport: state.lastReport || null,
    checks,
    faults,
  };
}
