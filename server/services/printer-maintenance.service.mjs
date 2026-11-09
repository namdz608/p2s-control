import { isBusy } from './printer-command.service.mjs';

const activeStates = new Set(['awaiting_start', 'running', 'uncertain']);
export class PrinterMaintenanceService {
  constructor(printer, { startTimeoutMs = 60000 } = {}) {
    this.printer = printer;
    this.startTimeoutMs = startTimeoutMs;
    this.state = { status: 'idle', message: 'Chưa chạy hiệu chuẩn trong phiên này.' };
  }
  get active() {
    return activeStates.has(this.state.status);
  }
  snapshot() {
    return { ...this.state, active: this.active };
  }
  set(status, message) {
    if (status !== 'awaiting_start') clearTimeout(this.timer);
    this.state = { ...this.state, status, message, updatedAt: new Date().toISOString() };
    this.printer.event(message, ['failed', 'uncertain'].includes(status) ? 'error' : 'info');
  }
  begin(sequence) {
    this.observedRun = false;
    this.observedFile = false;
    this.state = { sequence: String(sequence), startedAt: new Date().toISOString() };
    this.set('awaiting_start', 'Đã gửi yêu cầu hiệu chuẩn. Đang chờ máy xác nhận bắt đầu.');
    this.timer = setTimeout(() => this.uncertain(), this.startTimeoutMs);
    this.timer.unref();
  }
  uncertain() {
    if (this.active)
      this.set(
        'uncertain',
        'Chưa xác nhận được hiệu chuẩn. Kiểm tra trực tiếp máy rồi kết nối lại để đọc trạng thái; không gửi lại khi máy đang chạy.',
      );
  }
  observe(report) {
    if (!this.active) return;
    const reply = report.print;
    if (!reply) return;
    if (
      reply.command === 'calibration' &&
      String(reply.sequence_id) === this.state.sequence &&
      ['fail', 'failed'].includes(reply.result)
    ) {
      this.set(
        'failed',
        'Máy từ chối hiệu chuẩn. Kiểm tra Developer Mode, firmware và lỗi trên màn hình máy.',
      );
      return;
    }
    if (!['gcode_state', 'gcode_file', 'print_error'].some((key) => key in reply)) return;
    const state = this.printer.raw.print || {};
    if (Object.hasOwn(reply, 'gcode_file')) this.observedFile = true;
    const calibration =
      this.observedFile &&
      typeof state.gcode_file === 'string' &&
      state.gcode_file.includes('auto_cali_for_user');
    if (this.observedRun && !calibration) {
      if (this.state.status !== 'uncertain') this.uncertain();
      return;
    }
    if (isBusy(state.gcode_state) && calibration && this.state.status !== 'running') {
      this.observedRun = true;
      this.set('running', 'Máy đã xác nhận đang chạy hiệu chuẩn. Theo dõi trực tiếp máy.');
    } else if (this.observedRun && Object.hasOwn(reply, 'gcode_state')) {
      if (state.print_error || state.gcode_state === 'FAILED')
        this.set('failed', 'Hiệu chuẩn bị dừng hoặc có lỗi. Kiểm tra màn hình máy.');
      else if (['FINISH', 'IDLE'].includes(state.gcode_state))
        this.set('completed', 'Máy đã kết thúc hiệu chuẩn. Kiểm tra kết quả trên màn hình máy.');
    }
  }
  disconnect() {
    clearTimeout(this.timer);
    if (this.active)
      this.set(
        'interrupted',
        'Mất phiên theo dõi hiệu chuẩn. Kết nối lại để đọc trạng thái thực tế trên máy.',
      );
  }
}
