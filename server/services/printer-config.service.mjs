import { AppError } from '../errors/app-error.mjs';
import { validateConfig } from '../validators/printer-config.validator.mjs';

export class PrinterConfigService {
  constructor(config, printer, camera, timelapse) {
    this.config = config;
    this.printer = printer;
    this.camera = camera;
    this.timelapse = timelapse;
  }

  get() {
    return this.config.public();
  }

  async update(input) {
    if (this.timelapse?.busy)
      throw new AppError('Dừng ghi và đợi ghép timelapse xong trước khi đổi máy in.', 409);
    if (this.printer.maintenance?.active)
      throw new AppError('Đợi hiệu chuẩn kết thúc trước khi thay cấu hình máy in.', 409);
    if (this.printer.jobPending || this.printer.configPending || this.printer.queueActive)
      throw new AppError('Đợi tác vụ hiện tại xong trước khi thay cấu hình.', 409);
    this.printer.configPending = true;
    try {
      const validated = validateConfig(input, this.config.get());
      await this.printer.close();
      await this.config.save(validated);
      await this.printer.start();
      this.camera.configure?.().catch(() => {});
      return this.config.public();
    } finally {
      this.printer.configPending = false;
    }
  }

  async reconnect() {
    if (this.printer.maintenance?.snapshot().status === 'running')
      throw new AppError('Máy đang hiệu chuẩn. Đợi máy kết thúc trước khi kết nối lại.', 409);
    if (this.printer.jobPending || this.printer.configPending || this.printer.queueActive)
      throw new AppError('Đang gửi tác vụ in hoặc đổi kết nối.', 409);
    this.printer.configPending = true;
    try {
      await this.printer.start();
    } finally {
      this.printer.configPending = false;
    }
  }
}
