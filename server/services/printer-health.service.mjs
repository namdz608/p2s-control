import { inspectPrinter, printerFaults } from '../models/printer-health.model.mjs';

export async function lookupPrinterError(code, request = fetch) {
  if (!/^(?:[0-9A-F]{8}|[0-9A-F]{16})$/.test(code)) return null;
  const response = await request(`https://e.bambulab.com/query.php?lang=en&e=${code}`, {
    signal: AbortSignal.timeout(4000),
    redirect: 'error',
  });
  if (!response.ok) return null;
  const data = await response.json();
  const group = code.length === 8 ? 'device_error' : 'device_hms';
  const entries = data?.data?.[group]?.en;
  const entry = Array.isArray(entries)
    ? entries.find((item) => item.ecode?.toUpperCase() === code)
    : null;
  return data.result === 0 && typeof entry?.intro === 'string' && entry.intro.trim()
    ? entry.intro.slice(0, 3000)
    : null;
}

export class PrinterHealthService {
  constructor(printer, { lookup = lookupPrinterError } = {}) {
    this.printer = printer;
    this.lookup = lookup;
    this.cache = new Map();
    this.pending = new Map();
    this.lastCheck = null;
  }
  snapshot() {
    const state = this.printer.snapshot();
    const faults = printerFaults(state).map((fault) => ({
      ...fault,
      description: this.cache.get(fault.code)?.description || fault.description,
      translated: false,
    }));
    return { ...inspectPrinter(state, faults), lastCheck: this.lastCheck };
  }
  async resolveFaults() {
    const faults = printerFaults(this.printer.snapshot());
    // Bound outbound work even if a malformed device floods HMS entries.
    await Promise.all(
      faults.slice(0, 20).map(async ({ code }) => {
        const cached = this.cache.get(code);
        if (cached && cached.until > Date.now()) return;
        if (this.pending.has(code)) return this.pending.get(code);
        const task = (async () => {
          let description = null;
          try {
            description = await this.lookup(code);
          } catch {
            /* Offline help keeps the code visible. */
          }
          if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
          this.cache.set(code, {
            description,
            until: Date.now() + (description ? 86400000 : 60000),
          });
        })();
        this.pending.set(code, task);
        try {
          await task;
        } finally {
          this.pending.delete(code);
        }
      }),
    );
  }
  async run(settings) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.check(settings);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
  async check(settings) {
    let received = false;
    let message = 'Chưa cấu hình máy in.';
    if (settings.get().configured) {
      try {
        const state = this.printer.snapshot();
        if (state.connection !== 'connected') await settings.reconnect();
        await this.printer.refreshStatus();
        received = true;
        message = 'Đã nhận phản hồi trạng thái mới từ máy in.';
      } catch (error) {
        message = error.message;
      }
    }
    await this.resolveFaults();
    this.lastCheck = { at: new Date().toISOString(), received, message };
    this.printer.event(`Kiểm tra máy in: ${message}`, received ? 'info' : 'error');
    return this.snapshot();
  }
}
