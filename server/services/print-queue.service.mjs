import { AppError } from '../errors/app-error.mjs';
import { buildPrintRequest } from './print-request.service.mjs';

const activeStatuses = new Set(['preparing', 'submitting', 'awaiting_start', 'printing']);

// Prefer an explicit AMS1…AMS254 suffix. Otherwise only select an unambiguous
// material/color match; never silently choose among several compatible spools.
export function automaticPrintInput(project, plate, state) {
  const trays = (state.ams || []).flatMap((unit) =>
    unit.trays
      .filter((tray) => tray.type)
      .map((tray) => ({
        ...tray,
        slot: Number(unit.id) * 4 + Number(tray.id),
      })),
  );
  const mapping = Array(plate.filamentCount).fill(-1);
  const namedSlot = project.name.match(/(?:^|[-_\s])AMS(\d+)(?:$|[-_\s])/i);
  for (const filament of plate.filaments) {
    let candidates = trays.filter(
      (tray) => tray.type.toUpperCase() === filament.type.toUpperCase(),
    );
    if (namedSlot && plate.filaments.length === 1) {
      candidates = candidates.filter((tray) => tray.slot === Number(namedSlot[1]) - 1);
    } else if (candidates.length > 1 && filament.color) {
      candidates = candidates.filter(
        (tray) =>
          tray.color?.slice(0, 7).toUpperCase() === filament.color.slice(0, 7).toUpperCase(),
      );
    }
    if (candidates.length !== 1) {
      throw new AppError(
        `“${project.name}” · Plate ${plate.number}: chưa xác định được khay AMS cho filament ${filament.id}. Đặt hậu tố AMS1, AMS2… theo khay hoặc dùng In riêng để chọn vật liệu.`,
      );
    }
    mapping[filament.id - 1] = candidates[0].slot;
  }
  const input = { plate: plate.number, useAms: true, mapping, confirmed: true };
  buildPrintRequest(project, input, state);
  return input;
}

export class PrintQueueService {
  constructor(projects) {
    this.projects = projects;
    this.printer = projects.printer;
    this.status = 'idle';
    this.items = [];
    this.index = 0;
    this.message = '';
    this.token = null;
    this.inFlight = null;
  }

  get active() {
    return activeStatuses.has(this.status);
  }

  snapshot() {
    return {
      status: this.status,
      active: this.active,
      message: this.message,
      current: this.index,
      completed: this.items.filter((item) => item.status === 'completed').length,
      items: this.items.map(({ id, name, plate, status, mapping }) => ({
        id,
        name,
        plate,
        status,
        mapping,
      })),
    };
  }

  async start(input) {
    if (this.printer.maintenance?.active)
      throw new AppError(
        'Đợi hiệu chuẩn kết thúc và xác minh máy trước khi bắt đầu hàng đợi.',
        409,
      );
    if (this.active) throw new AppError('Hàng đợi đang chạy. Đợi hoàn tất hoặc hủy hàng đợi.', 409);
    if (this.printer.jobPending || this.printer.configPending)
      throw new AppError('Đang gửi tác vụ hoặc đổi kết nối. Vui lòng đợi.', 409);
    if (input?.confirmed !== true) throw new AppError('Cần xác nhận bắt đầu in tất cả tệp.');
    const token = (this.token = Symbol('queue'));
    this.status = 'preparing';
    this.printer.queueActive = true;
    this.items = [];
    this.index = 0;
    this.message = 'Đang kiểm tra tất cả tệp và vật liệu…';
    try {
      this.printer.assertReady();
      const state = this.printer.snapshot();
      // Check readiness before material selection so the actual blocking reason is visible.
      if (state.sdcard !== true)
        throw new AppError(
          'Máy in chưa nhận thẻ nhớ (sdcard=false hoặc chưa rõ). Lắp/kiểm tra thẻ nhớ rồi thử lại.',
          409,
        );
      const projects = (await this.projects.list()).sort(
        (a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }) || a.id.localeCompare(b.id),
      );
      if (token !== this.token) return this.snapshot();
      if (!projects.length) throw new AppError('Chưa có tệp trong thư viện.');
      this.items = projects.flatMap((project) =>
        [...project.plates]
          .sort((a, b) => a.number - b.number)
          .map((plate) => {
            const request = automaticPrintInput(project, plate, state);
            return {
              id: project.id,
              name: project.name,
              plate: plate.number,
              mapping: request.mapping,
              request,
              status: 'pending',
            };
          }),
      );
      if (!this.items.length) throw new AppError('Không có plate để in.');
      this.timer = setInterval(() => {
        void this.tick();
      }, 2000);
      this.timer.unref();
      this.inFlight = this.submitNext(token);
      return this.snapshot();
    } catch (error) {
      if (token === this.token) this.fail(error.message);
      throw error;
    }
  }

  async submitNext(token) {
    if (token !== this.token || !this.active) return;
    const item = this.items[this.index];
    this.status = 'submitting';
    item.status = 'submitting';
    this.message = `Đang gửi ${this.index + 1}/${this.items.length}: ${item.name} · Plate ${item.plate}`;
    try {
      await this.projects.start(item.id, item.request, token);
      if (token !== this.token || !this.active) return;
      this.submittedAt = Date.now();
      this.status = 'awaiting_start';
      item.status = 'awaiting_start';
      this.message = `Chờ máy bắt đầu: ${item.name} · Plate ${item.plate}`;
    } catch (error) {
      if (token === this.token && this.active) this.fail(error.message);
    }
  }

  async tick() {
    if (!this.active || this.ticking || ['preparing', 'submitting'].includes(this.status)) return;
    this.ticking = true;
    try {
      const state = this.printer.snapshot();
      const item = this.items[this.index];
      if (this.status === 'awaiting_start' && Date.now() - this.submittedAt > 90000) {
        this.fail('Máy chưa xác nhận bắt đầu in. Kiểm tra máy trước khi tạo lại hàng đợi.');
        return;
      }
      if (!state.fresh || state.configPending) return;
      if (this.status === 'printing' && state.status === 'FAILED') {
        this.fail('Máy in báo lỗi. Hàng đợi đã dừng; kiểm tra máy trước khi in lại.');
        return;
      }
      const busy = ['RUNNING', 'PREPARE', 'SLICING', 'PAUSE'].includes(state.status);
      if (this.status === 'awaiting_start') {
        if (busy && state.task === item.name) {
          this.status = item.status = 'printing';
          this.message = `Đang in ${this.index + 1}/${this.items.length}: ${item.name} · Plate ${item.plate}`;
        } else if (!busy && !state.jobPending) {
          this.fail('Máy chưa xác nhận đúng tệp đã gửi. Hàng đợi đã dừng để tránh gửi trùng.');
        }
        return;
      }
      if (state.task !== item.name) {
        this.fail('Tác vụ trên máy đã thay đổi. Hàng đợi đã dừng.');
        return;
      }
      if (state.status === 'FINISH') {
        item.status = 'completed';
        this.index++;
        if (this.index === this.items.length) {
          this.status = 'completed';
          this.message = `Đã in xong ${this.items.length} plate trong hàng đợi.`;
          this.release();
          this.printer.event(this.message);
        } else {
          this.inFlight = this.submitNext(this.token);
          await this.inFlight;
        }
      } else if (state.status === 'IDLE') {
        this.fail('Tác vụ đã kết thúc mà chưa xác nhận hoàn thành. Hàng đợi đã dừng.');
      }
    } catch (error) {
      this.fail(error.message);
    } finally {
      this.ticking = false;
    }
  }

  release() {
    clearInterval(this.timer);
    this.timer = null;
    this.printer.queueActive = false;
  }

  fail(message) {
    if (this.items[this.index]) this.items[this.index].status = 'failed';
    this.status = 'failed';
    this.message = message;
    this.release();
    this.printer.event(`Hàng đợi đã dừng: ${message}`, 'error');
  }

  cancel() {
    if (!this.active) return this.snapshot();
    this.token = null;
    this.status = 'cancelled';
    for (const item of this.items) if (item.status !== 'completed') item.status = 'cancelled';
    this.message =
      'Đã hủy các lượt còn lại. Tệp đã bắt đầu in vẫn tiếp tục; dùng Dừng in để dừng máy.';
    this.release();
    this.printer.event('Đã hủy hàng đợi in.');
    return this.snapshot();
  }
}
