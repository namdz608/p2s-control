import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.mjs';
import { printerFaults } from '../models/printer-health.model.mjs';
import { makeCommand } from './printer-command.service.mjs';

const resting = new Set(['IDLE', 'FINISH', 'FAILED']);
const inactive = new Set(['idle', 'completed', 'cancelled']);
const motion = new Set(['pushing_old', 'unloading', 'loading', 'pushing_new', 'pushing_purge']);
const telemetryFields = ['ams_status', 'extruder_state', 'extruder_info'];
const temperature = (value) => Number.isInteger(value) && value >= 170 && value <= 300;
const purgeAtTemperature = (current, target) =>
  Number.isFinite(current) && current >= 170 && Math.abs(current - target) <= 3;
// The busy bit stays set during this stalled AMS step. Motor direction is checked separately.
const pausedPullback = (raw) =>
  raw?.gcode_state === 'PAUSE' && raw.print_error === 0x07008004 && raw.ams_status === 0x104;
const purgeTimeouts = {
  awaiting_purge_heat: 15000,
  ready_purge: 60000,
  pushing_purge: 15000,
  restoring_purge: 20000,
};
const purgeFaults = (state, stalled) =>
  printerFaults(state).some(
    (fault) =>
      fault.severity === 'error' &&
      fault.code !== '0300110000020002' &&
      !(stalled && (fault.code === '07008004' || /^07002[0-3]0000020011$/.test(fault.code))),
  );
const verifiedSteps = {
  ready_old: 'Đầu phun đủ nhiệt cho sợi cũ',
  verify_old: 'Đầu đùn đã dừng đẩy sợi cũ',
  unloading: 'Đã xác nhận nhựa cũ ra',
  waiting_external: 'Đã rút sợi cũ',
  waiting_ams_swap: 'Đã rút sợi cũ',
  loading: 'Đã rút sợi cũ',
  verify_new: 'Đã nạp sợi mới',
  ready_new: 'Đầu phun đủ nhiệt để đẩy thêm',
  ready_purge: 'Đầu phun đủ nhiệt để đùn',
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
  awaiting_purge_heat: 'Đã gửi yêu cầu. Đang chờ P2S xác nhận nhiệt độ mục tiêu.',
  heating_purge: 'P2S đã nhận nhiệt độ mục tiêu. Đang nung đầu phun.',
  ready_purge: 'Đã đủ nhiệt. Xác nhận qua camera đầu phun ở trên máng xả trước khi đùn.',
  pushing_purge: 'Đang chờ máy báo kết thúc nhịp đùn.',
  restoring_purge: 'Đang trả nhiệt độ mục tiêu về mức trước khi nung.',
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
      pausedPullback: pausedPullback(this.printer.raw.print),
    };
  }

  set(status, message) {
    clearTimeout(this.timer);
    this.state = { ...this.state, status };
    if (verifiedSteps[status]) this.state.lastVerified = verifiedSteps[status];
    this.message = message;
    if (this.active && status !== 'uncertain') {
      this.timer = setTimeout(() => void this.expire(), purgeTimeouts[status] ?? 180000);
      this.timer.unref();
    }
  }

  interrupt(message) {
    if (this.active) this.set('uncertain', message);
  }

  async expire() {
    if (this.state.mode === 'purge') {
      if (this.state.status !== 'restoring_purge') {
        try {
          const { state } = this.checkIdle({ purge: true, faults: false });
          const pendingPush = this.state.status === 'pushing_purge';
          const pendingHeat = this.state.status === 'awaiting_purge_heat';
          await this.restorePurge(
            state,
            pendingPush ? 'uncertain' : 'cancelled',
            pendingPush
              ? 'Hết thời gian chờ máy xác nhận nhịp đùn. Kiểm tra P2S trước khi thử lại.'
              : pendingHeat
                ? 'P2S chưa xác nhận nhiệt độ yêu cầu. Kiểm tra trạng thái máy trước khi thử lại.'
                : 'Hết thời gian chờ. Đã kết thúc thao tác đùn.',
          );
          return;
        } catch {
          // The printer may have taken ownership of the heater again.
        }
      }
      this.interrupt(
        this.state.status === 'restoring_purge' && this.purgeRestoreNeedsProof
          ? 'P2S chưa xác nhận thay đổi nhiệt độ. Kiểm tra nhiệt độ mục tiêu trước khi thử lại.'
          : 'Hết thời gian chờ phản hồi. Kiểm tra vị trí đầu phun và nhiệt độ trên P2S.',
      );
      return;
    }
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

  checkIdle({ faults = true, purge = false } = {}) {
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
    const stalled = purge && pausedPullback(raw);
    if (
      !(resting.has(state.status) || (purge && state.status === 'PAUSE')) ||
      extruder.direction ||
      (!stalled && (extruder.busy || ![0, 3].includes(raw.ams_status >> 8)))
    )
      throw new AppError('Máy đang bận hoặc đang đẩy filament. Đợi máy rảnh rồi thử lại.', 409);
    const blocked = purge
      ? purgeFaults(state, stalled)
      : printerFaults(state).some((fault) => fault.severity === 'error');
    if (faults && blocked) throw new AppError('Xử lý lỗi trên P2S trước khi đổi filament.', 409);
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
    const purge =
      input.action === 'startPurge' || (this.state.mode === 'purge' && input.action !== 'start');
    const report = this.printer.snapshot();
    if (!this.telemetryFresh(report) || (purge && !report.fieldFresh.nozzle_target_temper))
      await this.printer.refreshStatus(10000, [
        'gcode_state',
        'print_error',
        'hms',
        ...telemetryFields,
        ...(purge ? ['nozzle_target_temper'] : []),
      ]);
    if (purge) return this.commandPurge(input);
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

  async commandPurge(input) {
    const status = this.state.status;
    const invalid = () => new AppError('Thao tác không phù hợp với bước đùn hiện tại.', 409);
    if (input.action === 'startPurge') {
      if (this.active) throw new AppError('Đang có một thao tác filament.', 409);
      const { state } = this.checkIdle({ purge: true });
      if (!temperature(input.temperature)) throw new AppError('Nhập nhiệt độ từ 170 đến 300 °C.');
      if (
        !state.fieldFresh.nozzle_target_temper ||
        !Number.isInteger(state.nozzle.target) ||
        state.nozzle.target < 0 ||
        state.nozzle.target > 300
      )
        throw new AppError('Chưa đọc được nhiệt độ mục tiêu trước khi đùn.', 409);
      this.state = { id: randomUUID(), mode: 'purge', temperature: input.temperature };
      this.previousPurgeTarget = state.nozzle.target;
      this.purgeHeatSeen = false;
      this.purgeContextLost = false;
      this.purgeJob =
        state.status === 'PAUSE' ? { file: state.activeFile, id: this.purgeJobId() } : null;
      await this.heat('awaiting_purge_heat', input.temperature);
      if (this.state.status === 'awaiting_purge_heat') void this.printer.pushall().catch(() => {});
    } else {
      if (!this.active || input.id !== this.state.id) throw invalid();
      if (input.action === 'cancel' && !motion.has(status) && status !== 'restoring_purge') {
        if (this.samePurgeContext(this.printer.snapshot())) {
          const { state } = this.checkIdle({ purge: true, faults: false });
          await this.restorePurge(state, 'cancelled', 'Đã kết thúc thao tác đùn.');
        } else {
          this.set(
            'cancelled',
            'Trạng thái bản in đã thay đổi. P2S đang quản lý nhiệt độ mục tiêu.',
          );
        }
      } else if (input.action === 'pushPurge') {
        if (status === 'awaiting_purge_heat' || status === 'heating_purge')
          throw new AppError('Đầu phun chưa đủ nhiệt.', 409);
        if (status !== 'ready_purge') throw invalid();
        const { state } = this.checkIdle({ purge: true });
        if (!this.samePurgeContext(state)) throw invalid();
        if (
          !state.fieldFresh.nozzle_temper ||
          !state.fieldFresh.nozzle_target_temper ||
          state.nozzle.target !== this.state.temperature ||
          !purgeAtTemperature(state.nozzle.current, this.state.temperature)
        )
          throw new AppError('Đầu phun chưa đủ nhiệt hoặc nhiệt độ đã thay đổi.', 409);
        await this.send('pushing_purge', 'set_extrusion_length', { extruder_index: 0, length: 10 });
      } else {
        throw invalid();
      }
    }
    return this.snapshot();
  }

  purgeJobId() {
    const report = this.printer.raw.print;
    return report?.subtask_id ?? report?.task_id ?? report?.job_id ?? null;
  }

  samePurgeContext(state) {
    if (this.purgeContextLost) return false;
    if (!this.purgeJob) return resting.has(state.status);
    return (
      state.status === 'PAUSE' &&
      state.activeFile === this.purgeJob.file &&
      this.purgeJobId() === this.purgeJob.id
    );
  }

  async restorePurge(state, status, message) {
    if (!this.samePurgeContext(state)) throw new AppError('Trạng thái bản in đã thay đổi.', 409);
    if (!state.fieldFresh.nozzle_target_temper)
      throw new AppError('Chưa đọc được nhiệt độ mục tiêu hiện tại.', 409);
    const target = this.state.temperature;
    const previous = this.previousPurgeTarget;
    const heatPending = !this.purgeHeatSeen && state.nozzle.target === previous;
    if (previous === target || (state.nozzle.target !== target && !heatPending)) {
      this.set(status, message);
      return;
    }
    this.purgeAfterRestore = { status, message };
    this.purgeRestoreNeedsProof = heatPending;
    await this.heat('restoring_purge', previous);
  }

  async observePurge(delta, snapshot, extruder, rejected, newExtruder) {
    const status = this.state.status;
    const raw = this.printer.raw.print;
    if (delta.nozzle_target_temper === this.state.temperature) this.purgeHeatSeen = true;
    if (rejected && status === 'pushing_purge' && this.samePurgeContext(snapshot)) {
      try {
        const { state } = this.checkIdle({ purge: true, faults: false });
        await this.restorePurge(
          state,
          'cancelled',
          'P2S từ chối đùn. Kiểm tra thông báo trên máy.',
        );
        return;
      } catch {
        // Report the failed command below if the target cannot be restored.
      }
    }
    if (!this.samePurgeContext(snapshot)) this.purgeContextLost = true;
    if (
      rejected ||
      !this.samePurgeContext(snapshot) ||
      (status !== 'restoring_purge' && purgeFaults(snapshot, pausedPullback(raw)))
    ) {
      this.interrupt(
        'P2S từ chối lệnh hoặc trạng thái máy đã thay đổi. Kiểm tra nhiệt độ và camera.',
      );
      return;
    }
    if (
      status === 'restoring_purge' &&
      delta.nozzle_target_temper === this.previousPurgeTarget &&
      (!this.purgeRestoreNeedsProof || this.purgeHeatSeen || this.accepted)
    ) {
      this.set(this.purgeAfterRestore.status, this.purgeAfterRestore.message);
    } else if (status === 'awaiting_purge_heat' || status === 'heating_purge') {
      if (Number.isFinite(delta.nozzle_temper)) this.observedTemperature = true;
      if (this.purgeHeatSeen && raw.nozzle_target_temper === this.state.temperature) {
        if (
          this.observedTemperature &&
          purgeAtTemperature(raw.nozzle_temper, this.state.temperature)
        )
          this.set('ready_purge');
        else if (status === 'awaiting_purge_heat') this.set('heating_purge');
      } else if (status === 'heating_purge') {
        this.interrupt('P2S đã thay đổi nhiệt độ mục tiêu. Kiểm tra trạng thái máy trước khi đùn.');
      }
    } else if (status === 'pushing_purge' && newExtruder && extruder) {
      if (extruder.direction === 1) this.observedAction = true;
      if ((this.observedAction || this.accepted) && extruder.direction === 0) {
        try {
          const { state } = this.checkIdle({ purge: true });
          await this.restorePurge(
            state,
            'completed',
            'Máy đã phản hồi lệnh đùn. Kiểm tra nhựa đã ra qua camera.',
          );
        } catch {
          this.interrupt('Máy đã báo xong nhịp đùn. Chưa xác nhận được khôi phục nhiệt độ.');
        }
      }
    }
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
    if (this.state.mode === 'purge')
      return this.observePurge(delta, snapshot, extruder, rejected, newExtruder);
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
