import { AppError } from '../errors/app-error.mjs';
import { isBusy } from './printer-command.service.mjs';

export function buildPrintRequest(project, input, state) {
  if (input?.confirmed !== true)
    throw new AppError('Xác nhận tệp đã slice đúng P2S và bàn in đã sẵn sàng.');
  if (isBusy(state.status) || !['IDLE', 'FINISH', 'FAILED'].includes(state.status))
    throw new AppError('Máy đang bận hoặc chưa có trạng thái sẵn sàng.', 409);
  if (state.sdcard !== true) throw new AppError('Chưa xác nhận được thẻ nhớ trong máy in.', 409);
  const plate = project.plates.find((item) => item.number === input.plate);
  if (!plate) throw new AppError('Plate không có trong tệp in.');
  if (typeof input.useAms !== 'boolean') throw new AppError('Chọn nguồn vật liệu.');
  if (input.mappingMode !== undefined && !['auto', 'manual'].includes(input.mappingMode))
    throw new AppError('Cách chọn khay không hợp lệ.');
  let mapping = [];
  if (input.useAms) {
    mapping = input.mapping;
    if (
      !Array.isArray(mapping) ||
      mapping.length !== plate.filamentCount ||
      mapping.some((value) => !Number.isInteger(value) || value < -1 || value > 253)
    )
      throw new AppError(`Bảng AMS cần đủ ${plate.filamentCount} vị trí của dự án.`);
    for (const filament of plate.filaments) {
      const selected = mapping[filament.id - 1];
      const unit = state.ams.find((item) => Number(item.id) === Math.floor(selected / 4));
      const tray = unit?.trays.find((item) => Number(item.id) === selected % 4);
      if (!tray)
        throw new AppError(`Khay AMS chọn cho filament ${filament.id} không có trong dữ liệu máy.`);
      if (!tray.type && input.mappingMode !== 'manual')
        throw new AppError(`Chọn khay AMS có vật liệu cho filament ${filament.id}.`);
      if (tray.type && tray.type.toUpperCase() !== filament.type.toUpperCase())
        throw new AppError(
          `Filament ${filament.id} cần ${filament.type}; khay chọn đang chứa ${tray.type}.`,
        );
      const color = (value) =>
        /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(value || '')
          ? value.slice(0, 7).toUpperCase()
          : null;
      const expectedColor = color(filament.color);
      const actualColor = color(tray.color);
      if (
        input.mappingMode !== 'manual' &&
        expectedColor &&
        actualColor &&
        expectedColor !== actualColor
      )
        throw new AppError(
          `Filament ${filament.id} cần màu ${expectedColor}; khay AMS ${Math.floor(selected / 4) + 1} · A${(selected % 4) + 1} đang khai báo màu ${actualColor}. Chọn khay đúng màu hoặc sửa khai báo vật liệu trên máy in.`,
        );
    }
  } else if (plate.filaments.length > 1)
    throw new AppError('Plate nhiều vật liệu cần chọn AMS và ánh xạ khay.');
  return {
    print: {
      command: 'project_file',
      param: `Metadata/plate_${plate.number}.gcode`,
      url: `ftp:///${project.id}.gcode.3mf`,
      subtask_name: project.name,
      use_ams: input.useAms,
      ams_mapping: mapping,
      bed_type: 'auto',
      bed_leveling: true,
      flow_cali: true,
      vibration_cali: true,
      layer_inspect: false,
      timelapse: false,
      profile_id: '0',
      project_id: '0',
      subtask_id: '0',
      task_id: '0',
    },
  };
}
