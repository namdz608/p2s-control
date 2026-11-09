import { PrintQueueService } from './print-queue.service.mjs';
import { randomBytes } from 'node:crypto';
import { AppError } from '../errors/app-error.mjs';
import { ProjectModel } from '../models/project.model.mjs';
import { inspectArchive, readPlatePreview } from './project-archive.service.mjs';
import { buildPrintRequest } from './print-request.service.mjs';
import { uploadPrinterFile } from './printer-file.service.mjs';

export class ProjectService {
  static async open(directory, printer, config, upload = uploadPrinterFile) {
    const model = await ProjectModel.open(directory);
    return new ProjectService(model, printer, config, upload);
  }

  constructor(model, printer, config, upload = uploadPrinterFile) {
    this.model = model;
    this.printer = printer;
    this.config = config;
    this.upload = upload;
    this.queue = new PrintQueueService(this);
  }

  list() {
    return this.model.list();
  }

  async preview(id) {
    const project = await this.model.get(id);
    const image = await readPlatePreview(this.model.file(project.id, 'gcode.3mf'));
    if (!image) throw new AppError('Tệp không có ảnh xem trước.', 404);
    return image;
  }

  async add(file) {
    const details = await inspectArchive(file.path);
    return this.model.add(file, details);
  }

  async remove(id) {
    if (this.queue.active) throw new AppError('Đợi hoặc hủy hàng đợi trước khi xóa tệp.', 409);
    if (this.printer.jobPending) throw new AppError('Đang gửi tệp in. Đợi tác vụ hoàn tất.', 409);
    await this.model.remove(id);
  }

  async start(id, input, queueToken) {
    if (this.printer.maintenance?.active)
      throw new AppError(
        'Đang hiệu chuẩn hoặc chưa rõ kết quả hiệu chuẩn. Kiểm tra máy trước khi in.',
        409,
      );
    if (this.queue.active && queueToken !== this.queue.token)
      throw new AppError('Hàng đợi đang chạy. Đợi hoặc hủy hàng đợi trước khi in riêng.', 409);
    if (this.printer.jobPending || this.printer.configPending)
      throw new AppError('Đang gửi tác vụ in hoặc đổi kết nối. Vui lòng đợi.', 409);
    this.printer.jobPending = true;
    let submitted = false;
    try {
      this.printer.assertReady();
      const project = await this.model.get(id);
      const payload = buildPrintRequest(project, input, this.printer.snapshot());
      this.printer.event('Đang gửi tệp tới thẻ nhớ máy in…');
      try {
        await this.upload(this.config.get(), this.model.file(id, 'gcode.3mf'), `${id}.gcode.3mf`);
      } catch {
        throw new AppError(
          'Không gửi được tệp qua FTPS cổng 990. Kiểm tra Developer Mode, thẻ nhớ và kết nối.',
          502,
        );
      }
      if (queueToken && (!this.queue.active || queueToken !== this.queue.token))
        throw new AppError('Hàng đợi đã bị hủy.', 409);
      this.printer.assertReady();
      buildPrintRequest(project, input, this.printer.snapshot());
      payload.print.sequence_id = randomBytes(4).readUInt32BE().toString();
      this.printer.holdSubmission();
      await this.printer.publish(payload);
      submitted = true;
      this.printer.event('Đã gửi tác vụ in. Chờ máy in xác nhận và cập nhật tiến độ.');
    } finally {
      if (!submitted) {
        this.printer.cancelSubmission?.();
        this.printer.jobPending = false;
      }
    }
  }
}
