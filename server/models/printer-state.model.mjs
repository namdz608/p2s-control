const blocked = new Set(['__proto__', 'constructor', 'prototype']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function mergeReport(base, delta) {
  const result = object(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(delta ?? {})) {
    if (blocked.has(key)) continue;
    if (object(value)) result[key] = mergeReport(result[key], value);
    else if (Array.isArray(value))
      result[key] = value.map((item) => (object(item) ? mergeReport({}, item) : item));
    else result[key] = value;
  }
  return result;
}
const number = (value) =>
  value === undefined || value === null || value === '' || !Number.isFinite(Number(value))
    ? null
    : Number(value);
const array = (value) => (Array.isArray(value) ? value : []);
export function summarize(raw) {
  const p = raw.print ?? {};
  return {
    status: typeof p.gcode_state === 'string' ? p.gcode_state : 'UNKNOWN',
    task: p.subtask_name || null,
    activeFile: typeof p.gcode_file === 'string' ? p.gcode_file : null,
    progress: number(p.mc_percent),
    remaining: number(p.mc_remaining_time),
    layer: number(p.layer_num),
    totalLayers: number(p.total_layer_num),
    nozzle: { current: number(p.nozzle_temper), target: number(p.nozzle_target_temper) },
    bed: { current: number(p.bed_temper), target: number(p.bed_target_temper) },
    chamber: number(p.device?.ctc?.info?.temp ?? p.chamber_temper),
    speed: number(p.spd_lvl),
    wifi: typeof p.wifi_signal === 'string' ? p.wifi_signal : null,
    light: array(p.lights_report).find((item) => item.node === 'chamber_light')?.mode === 'on',
    sdcard: typeof p.sdcard === 'boolean' ? p.sdcard : null,
    printError: number(p.print_error),
    hms: array(p.hms)
      .filter(object)
      .map((item) => ({ attr: item.attr, code: item.code })),
    ams: array(p.ams?.ams).map((unit) => ({
      id: String(unit.id),
      humidity: number(unit.humidity_raw),
      humidityLevel: number(unit.humidity),
      temperature: number(unit.temp),
      trays: array(unit.tray).map((tray) => ({
        id: String(tray.id),
        type: tray.tray_type || '',
        name: tray.tray_sub_brands || tray.tray_type || 'Trống',
        color: /^[\dA-Fa-f]{8}$/.test(tray.tray_color ?? '')
          ? `#${tray.tray_color.slice(0, 6)}`
          : '#70777d',
        remaining:
          number(tray.remain) !== null && Number(tray.remain) >= 0 ? Number(tray.remain) : null,
        weight: number(tray.tray_weight),
      })),
    })),
  };
}
