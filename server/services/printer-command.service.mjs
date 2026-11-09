import { AppError } from '../errors/app-error.mjs';
export const isBusy = (status) => ['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'].includes(status);
export function makeCommand(input, sequence, status) {
  const print = (command) => ({ print: { sequence_id: String(sequence), command } });
  const bounded = (value, low, high) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high)
      throw new AppError(`Giá trị phải là số nguyên từ ${low} đến ${high}.`);
    return value;
  };
  switch (input.type) {
    case 'calibration': {
      if (input.confirmed !== true) throw new AppError('Cần xác nhận chạy hiệu chuẩn.');
      if (!['IDLE', 'FINISH', 'FAILED'].includes(status))
        throw new AppError('Chỉ chạy hiệu chuẩn khi máy đang rảnh.', 409);
      const options = input.options;
      const bits = { bedLeveling: 2, vibration: 4, motorNoise: 8 };
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.entries(options).some(
          ([key, value]) => !Object.hasOwn(bits, key) || typeof value !== 'boolean',
        )
      )
        throw new AppError('Các mục hiệu chuẩn không hợp lệ.');
      const option = Object.entries(bits).reduce(
        (value, [key, bit]) => value + (options[key] === true ? bit : 0),
        0,
      );
      if (!option) throw new AppError('Chọn ít nhất một mục hiệu chuẩn.');
      return { print: { ...print('calibration').print, option } };
    }
    case 'systemCheck': {
      if (input.confirmed !== true) throw new AppError('Cần xác nhận kiểm tra toàn hệ thống.');
      if (!['IDLE', 'FINISH', 'FAILED'].includes(status))
        throw new AppError('Chỉ kiểm tra toàn hệ thống khi máy đang rảnh.', 409);
      return { print: { ...print('calibration').print, option: 2 + 4 + 8 } };
    }
    case 'pause':
      if (status !== 'RUNNING') throw new AppError('Chỉ tạm dừng khi máy đang in.', 409);
      return print('pause');
    case 'resume':
      if (status !== 'PAUSE') throw new AppError('Chỉ tiếp tục khi máy đang tạm dừng.', 409);
      return print('resume');
    case 'stop':
      if (!isBusy(status)) throw new AppError('Máy hiện không có tác vụ để dừng.', 409);
      return print('stop');
    case 'light':
      if (typeof input.value !== 'boolean') throw new AppError('Trạng thái đèn không hợp lệ.');
      return {
        system: {
          sequence_id: String(sequence),
          command: 'ledctrl',
          led_node: 'chamber_light',
          led_mode: input.value ? 'on' : 'off',
          led_on_time: 500,
          led_off_time: 500,
          loop_times: 0,
          interval_time: 0,
        },
      };
    case 'speed':
      if (!isBusy(status)) throw new AppError('Đổi tốc độ khi máy có tác vụ in.', 409);
      return {
        print: { ...print('print_speed').print, param: String(bounded(input.value, 1, 4)) },
      };
    case 'nozzle':
    case 'bed': {
      const value = bounded(input.value, 0, input.type === 'nozzle' ? 300 : 110);
      if (value > 0 && input.confirmed !== true && input.confirmed !== undefined)
        throw new AppError('Cần xác nhận thay đổi nhiệt độ.');
      return {
        print: {
          ...print('gcode_line').print,
          param: `${input.type === 'nozzle' ? 'M104' : 'M140'} S${value}\n`,
        },
      };
    }
    default:
      throw new AppError('Lệnh không được hỗ trợ.');
  }
}
