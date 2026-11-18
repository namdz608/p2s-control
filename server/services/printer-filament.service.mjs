import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.mjs';
import { printerFaults } from '../models/printer-health.model.mjs';
import { makeCommand } from './printer-command.service.mjs';

const resting = new Set(['IDLE', 'FINISH', 'FAILED']);
const inactive = new Set(['idle', 'completed', 'cancelled']);
const motion = new Set(['pushing_old', 'unloading', 'loading', 'pushing_new']);
const telemetryFields = ['ams_status', 'extruder_state', 'extruder_info'];
const temperature = (value) => Number.isInteger(value) && value >= 170 && value <= 300;
const verifiedSteps = {
  ready_old: 'Đầu phun đủ nhiệt cho sợi cũ',
  verify_old: 'Đầu đùn đã dừng đẩy sợi cũ',
  unloading: 'Đã xác nhận nhựa cũ ra',
  waiting_external: 'Đã rút sợi cũ',
  waiting_ams_swap: 'Đã rút sợi cũ',
  loading: 'Đã rút sợi cũ',
  verify_new: 'Đã nạp sợi mới',
  ready_new: 'Đầu phun đủ nhiệt để đẩy thêm',
};
const messages = {
  idle: 'Chọn cuộn mới để bắt đầu.',
  heating_old: 'Đang nung đầu phun cho sợi cũ.',
  ready_old: 'Đã đủ nhiệt. Kiểm tra đầu phun ở trên máng xả rồi bấm Đẩy sợi cũ.',
  pushing_old: 'Đang chờ máy xác nhận đã đẩy sợi cũ.',
  verify_old: 'Kiểm tra nhựa cũ đã ra khỏi đầu phun rồi xác nhận để rút sợi cũ.',
  unloading: 'Đang rút sợi cũ. Với cuộn ngoài, làm theo hướng dẫn trên màn hình máy.',
  waiting_external: 'Đưa sợi mới từ cuộn ngoài vào ống PTFE rồi xác nhận để máy nạp.',
  waiting_ams_swap: 'Thay cuộn trong khay AMS đã chọn rồi xác nhận để máy nạp.',
  loading: 'Đang nạp sợi mới. Với cuộn ngoài, làm theo hướng dẫn trên màn hình máy.',
  verify_new: 'Kiểm tra nhựa mới ra đều rồi bấm Hoàn tất. Có thể đẩy thêm nếu còn lẫn màu cũ.',
  heating_new: 'Đang nung đầu phun để đẩy thêm sợi mới.',
  ready_new: 'Đã đủ nhiệt. Kiểm tra đầu phun ở trên máng xả rồi bấm Đẩy sợi mới.',
  pushing_new: 'Đang chờ máy xác nhận đã đẩy thêm sợi mới.',
  cooling: 'Đang chờ máy xác nhận đã tắt gia nhiệt.',
  completed: 'Đã hoàn tất đổi filament.',
  cancelled: 'Đã kết thúc thao tác đổi filament.',
  uncertain:
    'Chưa xác nhận được trạng thái. Kiểm tra trực tiếp trên P2S trước khi kết thúc thao tác.',
};

function readExtruder(device) {
  const extruder = device?.extruder;
  if (!Number.isInteger(extruder?.state) || (extruder.state & 15) !== 1) return null;
  const info = extruder.info?.find?.((entry) => entry?.id === 0);
  if (!Number.isInteger(info?.info) || !Number.isInteger(info.snow)) return null;
  const ams = (info.snow >> 8) & 255;
  const slot = info.snow & 255;
  return {
    loaded: (info.info & 2) !== 0,
    direction: (info.info >> 11) & 3,
    busy: (extruder.state & (1 << 19)) !== 0,
    source: slot === 255 ? null : ams >= 254 ? 'external' : `${ams}:${slot}`,
    ams,
    slot,
  };
}

function resolveTarget(source, raw) {
  if (source === 'external') {
    const trays = Array.isArray(raw.vir_slot) ? raw.vir_slot : [raw.vir_slot];
    const external =
      trays.find((tray) => String(tray?.id) === '255') ??
      trays.find((tray) => String(tray?.id) === '254');
    const ams = Number(external?.id ?? 255);
    return { ams, slot: 0, target: ams };
  }
  const match = typeof source === 'string' && /^(0|[1-9]\d{0,2}):([0-3])$/.exec(source);
  const ams = Number(match?.[1]);
  const slot = Number(match?.[2]);
  const unit = raw.ams?.ams?.find?.((item) => String(item.id) === String(ams));
  if (
    !match ||
    !(ams < 16 || (ams >= 128 && ams <= 135 && slot === 0)) ||
    !unit?.tray?.some?.((item) => Number(item.id) === slot && item.tray_type)
  )
    throw new AppError('Chọn khay AMS đã khai báo vật liệu hoặc chọn cuộn ngoài.');
  return { ams, slot, target: ams < 16 ? ams * 4 + slot : ams };
}

export class PrinterFilamentService {
  constructor(printer) {
    this.printer = printer;
    this.state = { status: 'idle' };
  }

  get active() {
    return !inactive.has(this.state.status);
  }

  snapshot() {
    const extruder = readExtruder(this.printer.raw.print?.device);
    return {
      ...this.state,
      active: this.active,
      message: this.message ?? messages[this.state.status],
      loaded: extruder?.loaded ?? null,
      currentSource: extruder?.source ?? null,
    };
  }

  set(status, message) {
    clearTimeout(this.timer);
    this.state = { ...this.state, status };
    if (verifiedSteps[status]) this.state.lastVerified = verifiedSteps[status];
    this.message = message;
    if (this.active && status !== 'uncertain') {
      this.timer = setTimeout(() => void this.expire(), 180000);
      this.timer.unref();
    }
  }

  interrupt(message) {
    if (this.active) this.set('uncertain', message);
  }

  async expire() {
    try {
      if (this.state.status !== 'cooling' && !motion.has(this.state.status)) {
        this.checkIdle({ faults: false });
        await this.cool('cancelled');
        return;
      }
    } catch {
      // A disconnected or busy printer may still have a command in progress.
    }
    this.interrupt(
      'Quá thời gian chờ. Kiểm tra trực tiếp đầu phun và trạng thái đổi sợi trên P2S.',
    );
  }

  checkIdle({ faults = true } = {}) {
    this.printer.assertReady();
    const state = this.printer.snapshot();
    const raw = this.printer.raw.print ?? {};
    const extruder = readExtruder(raw.device);
    if (
      state.configPending ||
      state.jobPending ||
      state.maintenance.active ||
      this.printer.queueActive
    )
      throw new AppError('Đợi tác vụ hiện tại kết thúc trước khi đổi filament.', 409);
    if (!this.telemetryFresh(state) || !extruder)
      throw new AppError(
        'Cần dữ liệu mới về đầu đùn và AMS từ P2S. Chạy kiểm tra kết nối rồi thử lại.',
        409,
      );
    if (
      !resting.has(state.status) ||
      extruder.busy ||
      extruder.direction ||
      ![0, 3].includes(raw.ams_status >> 8)
    )
      throw new AppError('Máy đang bận hoặc đang đẩy filament. Đợi máy rảnh rồi thử lại.', 409);
    if (faults && printerFaults(state).some((fault) => fault.severity === 'error'))
      throw new AppError('Xử lý lỗi trên P2S trước khi đổi filament.', 409);
    return { state, raw, extruder };
  }

  telemetryFresh(state) {
    return state.healthFresh && telemetryFields.every((field) => state.fieldFresh[field]);
  }

  async send(status, command, fields) {
    const payload = { print: { command, sequence_id: String(++this.printer.sequence), ...fields } };
    this.packet = payload.print;
    this.observedAction = false;
    this.accepted = false;
    this.observedTemperature = false;
    this.observedSource = false;
    this.observedAms = false;
    this.set(status);
    try {
      await this.printer.publish(payload);
    } catch (error) {
      if (this.packet === payload.print)
        this.interrupt('Gửi lệnh chưa được xác nhận. Kiểm tra trực tiếp trên P2S.');
      throw error;
    }
  }

  heat(status, value) {
    const { command, param } = makeCommand({ type: 'nozzle', value, confirmed: true }, 0).print;
    return this.send(status, command, { param });
  }

  async cool(status) {
    this.afterCooling = status;
    await this.heat('cooling', 0);
    if (this.state.status === 'cooling') await this.printer.pushall().catch(() => {});
  }

  load() {
    const { ams, slot, target } = this.target;
    return this.send('loading', 'ams_change_filament', {
      ams_id: ams,
      slot_id: slot,
      target,
      curr_temp: this.state.oldTemp,
      tar_temp: this.state.newTemp,
    });
  }

  newFilamentLoaded(extruder) {
    return (
      extruder.loaded &&
      extruder.source === this.state.source &&
      (this.state.source !== 'external' || extruder.ams === this.target.ams)
    );
  }

  async command(input) {
    if (input.confirmed !== true) throw new AppError('Cần xác nhận thao tác đổi filament.');
    if (this.state.status === 'uncertain' && input.action !== 'cancel')
      throw new AppError('Kiểm tra trạng thái máy trước khi kết thúc thao tác hiện tại.', 409);
    this.printer.assertReady();
    if (!this.telemetryFresh(this.printer.snapshot()))
      await this.printer.refreshStatus(10000, [
        'gcode_state',
        'print_error',
        'hms',
        ...telemetryFields,
      ]);
    if (input.action === 'start') {
      if (this.active) throw new AppError('Đang có một thao tác đổi filament.', 409);
      const { raw, extruder } = this.checkIdle();
      if (!extruder.loaded || !extruder.source)
        throw new AppError('Máy cần còn kẹp sợi cũ mới chạy được chu trình đẩy cũ trước.', 409);
      if (!temperature(input.oldTemp) || !temperature(input.newTemp))
        throw new AppError('Nhập nhiệt độ phù hợp với từng cuộn, từ 170 đến 300 °C.');
      const target = resolveTarget(input.source, raw);
      this.target = target;
      this.oldSource = extruder.source;
      this.state = {
        id: randomUUID(),
        source: input.source,
        oldTemp: input.oldTemp,
        newTemp: input.newTemp,
      };
      await this.heat('heating_old', input.oldTemp);
      return this.snapshot();
    }

    if (!this.active || input.id !== this.state.id)
      throw new AppError('Thao tác đã thay đổi. Tải lại trạng thái đổi filament.', 409);
    const status = this.state.status;
    const unexpected = () =>
      new AppError('Thao tác không phù hợp với bước hiện tại. Kiểm tra trạng thái máy.', 409);
    if (input.action === 'cancel' && !motion.has(status) && status !== 'cooling') {
      this.checkIdle({ faults: false });
      await this.cool('cancelled');
      return this.snapshot();
    }
    const { state, extruder } = this.checkIdle();
    switch (input.action) {
      case 'pushOld':
      case 'pushNew': {
        const old = input.action === 'pushOld';
        if (status === 'heating_old' || status === 'heating_new')
          throw new AppError('Đầu phun chưa đủ nhiệt.', 409);
        if (status !== (old ? 'ready_old' : 'ready_new')) throw unexpected();
        const expectedTemp = old ? this.state.oldTemp : this.state.newTemp;
        const matches = old
          ? extruder.loaded && extruder.source === this.oldSource
          : this.newFilamentLoaded(extruder);
        if (!matches)
          throw new AppError('Nguồn filament ở đầu đùn đã thay đổi. Kiểm tra P2S.', 409);
        if (
          !state.fieldFresh.nozzle_temper ||
          !state.fieldFresh.nozzle_target_temper ||
          state.nozzle.target !== expectedTemp ||
          Math.abs(state.nozzle.current - expectedTemp) > 3
        )
          throw new AppError('Đầu phun chưa đủ nhiệt hoặc nhiệt độ đã thay đổi.', 409);
        await this.send(old ? 'pushing_old' : 'pushing_new', 'set_extrusion_length', {
          extruder_index: 0,
          length: 10,
        });
        break;
      }
      case 'confirmOld':
        if (status !== 'verify_old' || !extruder.loaded || extruder.source !== this.oldSource)
          throw unexpected();
        await this.send('unloading', 'ams_change_filament', {
          ams_id: extruder.ams,
          slot_id: 255,
          target: 255,
          curr_temp: this.state.oldTemp,
          tar_temp: this.state.oldTemp,
        });
        break;
      case 'loadExternal':
        if (
          status !== 'waiting_external' ||
          (extruder.loaded && extruder.source && extruder.source !== 'external')
        )
          throw unexpected();
        await this.load();
        break;
      case 'loadAms':
        if (status !== 'waiting_ams_swap' || extruder.loaded) throw unexpected();
        this.target = resolveTarget(this.state.source, this.printer.raw.print);
        await this.load();
        break;
      case 'heatMore':
        if (status !== 'verify_new' || !this.newFilamentLoaded(extruder)) throw unexpected();
        await this.heat('heating_new', this.state.newTemp);
        break;
      case 'finish':
        if (status !== 'verify_new' || !this.newFilamentLoaded(extruder)) throw unexpected();
        await this.cool('completed');
        break;
      default:
        throw unexpected();
    }
    return this.snapshot();
  }

  async observe(report) {
    const delta = report.print;
    if (!delta) return;
    const raw = this.printer.raw.print ?? {};
    const extruder = readExtruder(raw.device);
    const status = this.state.status;
    if (!this.active || status === 'uncertain') return;
    const snapshot = this.printer.snapshot();
    const newExtruder =
      Array.isArray(delta.device?.extruder?.info) && snapshot.fieldFresh.extruder_info;
    const newExtruderState =
      Number.isInteger(delta.device?.extruder?.state) && snapshot.fieldFresh.extruder_state;
    const newAms = Number.isInteger(delta.ams_status) && snapshot.fieldFresh.ams_status;
    const matchingReply =
      this.packet &&
      delta.command === this.packet.command &&
      String(delta.sequence_id) === this.packet.sequence_id;
    if (matchingReply && (['success', 'ok'].includes(delta.result) || delta.errno === 0))
      this.accepted = true;
    const rejected =
      matchingReply && (['fail', 'failed'].includes(delta.result) || delta.errno < 0);
    const newFault =
      (Object.hasOwn(delta, 'print_error') || Object.hasOwn(delta, 'hms')) &&
      printerFaults(snapshot).some((fault) => fault.severity === 'error');
    if (rejected || newFault || (delta.gcode_state && !resting.has(delta.gcode_state))) {
      this.interrupt(
        'Máy báo lỗi, từ chối lệnh hoặc bắt đầu tác vụ khác. Kiểm tra trực tiếp trên P2S.',
      );
      return;
    }
    if (status === 'cooling' && delta.nozzle_target_temper === 0) {
      this.set(this.afterCooling);
    } else if (['heating_old', 'heating_new'].includes(status)) {
      if (Number.isFinite(delta.nozzle_temper)) this.observedTemperature = true;
      const old = status === 'heating_old';
      const target = old ? this.state.oldTemp : this.state.newTemp;
      if (
        this.observedTemperature &&
        raw.nozzle_target_temper === target &&
        Math.abs(raw.nozzle_temper - target) <= 3
      )
        this.set(old ? 'ready_old' : 'ready_new');
    } else if (['pushing_old', 'pushing_new'].includes(status) && newExtruder && extruder) {
      if (extruder.direction === 1) this.observedAction = true;
      if ((this.observedAction || this.accepted) && extruder.direction === 0)
        this.set(status === 'pushing_old' ? 'verify_old' : 'verify_new');
    } else if (
      ['unloading', 'loading'].includes(status) &&
      (newExtruder || newExtruderState || newAms)
    ) {
      const amsState = raw.ams_status >> 8;
      this.observedSource ||= newExtruder;
      this.observedAms ||= newAms;
      if ((newExtruderState && extruder?.busy) || (newAms && amsState === 1))
        this.observedAction = true;
      if (
        !this.observedAction ||
        !this.observedSource ||
        !this.observedAms ||
        !this.telemetryFresh(snapshot) ||
        !extruder ||
        extruder.busy ||
        ![0, 3].includes(amsState)
      )
        return;
      if (status === 'loading' && this.newFilamentLoaded(extruder)) {
        this.set('verify_new');
      } else if (status === 'unloading' && !extruder.loaded && !extruder.source) {
        if (this.state.source === 'external') {
          this.set('waiting_external');
        } else if (this.state.source === this.oldSource) {
          this.set('waiting_ams_swap');
        } else {
          try {
            this.checkIdle();
            resolveTarget(this.state.source, raw);
            await this.load();
          } catch {
            this.interrupt('Sợi cũ đã rút. Chưa xác nhận nạp được sợi mới. Kiểm tra P2S.');
          }
        }
      }
    }
  }
}
