import mqtt from 'mqtt';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { mergeReport, summarize } from '../models/printer-state.model.mjs';
import { makeCommand } from './printer-command.service.mjs';
import { AppError } from '../errors/app-error.mjs';
import { PrinterMaintenanceService } from './printer-maintenance.service.mjs';
import { blockingMaintenanceFaults, printerFaults } from '../models/printer-health.model.mjs';

function certificateAt(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert.raw) return reject(new Error('CERTIFICATE'));
      const pem = `-----BEGIN CERTIFICATE-----\n${cert.raw
        .toString('base64')
        .match(/.{1,64}/g)
        .join('\n')}\n-----END CERTIFICATE-----\n`;
      resolve({ pem, fingerprint: cert.fingerprint256 });
    });
    socket.setTimeout(6000, () => socket.destroy(new Error('TIMEOUT')));
    socket.once('error', reject);
  });
}

const healthFields = ['gcode_state', 'print_error', 'hms'];
const trackedFields = [...healthFields, 'sdcard', 'nozzle_temper', 'bed_temper'];
const uint32 = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
function validField(field, value) {
  if (field === 'gcode_state') return typeof value === 'string' && value.length > 0;
  if (field === 'print_error') return uint32(value);
  if (field === 'hms')
    return (
      Array.isArray(value) && value.every((item) => item && uint32(item.attr) && uint32(item.code))
    );
  if (field === 'sdcard') return typeof value === 'boolean';
  return typeof value === 'number' && Number.isFinite(value);
}

export class PrinterService {
  constructor(config, { port = 8883, freshnessMs = 120000 } = {}) {
    this.config = config;
    this.port = port;
    this.freshnessMs = freshnessMs;
    this.raw = {};
    this.connection = 'unconfigured';
    this.message = 'Thêm máy in để bắt đầu.';
    this.lastReport = null;
    this.events = [];
    this.sequence = 0;
    this.generation = 0;
    this.jobPending = false;
    this.configPending = false;
    this.maintenance = new PrinterMaintenanceService(this);
    this.reportWaiters = new Set();
    this.fieldReports = new Map();
    this.reportVersion = 0;
  }
  event(message, kind = 'info') {
    this.events.unshift({
      id: randomBytes(6).toString('hex'),
      at: new Date().toISOString(),
      message,
      kind,
    });
    this.events = this.events.slice(0, 60);
  }
  snapshot() {
    const fieldFresh = Object.fromEntries(
      trackedFields.map((field) => [
        field,
        this.connection === 'connected' &&
          this.fieldReports.has(field) &&
          Date.now() - this.fieldReports.get(field).at < this.freshnessMs,
      ]),
    );
    return {
      ...summarize(this.raw),
      connection: this.connection,
      message: this.message,
      lastReport: this.lastReport ? new Date(this.lastReport).toISOString() : null,
      fresh:
        this.connection === 'connected' &&
        this.lastReport !== null &&
        Date.now() - this.lastReport < this.freshnessMs,
      jobPending: this.jobPending,
      configPending: this.configPending,
      maintenance: this.maintenance.snapshot(),
      fieldFresh,
      healthFresh: healthFields.every((field) => fieldFresh[field]),
    };
  }
  assertReady() {
    if (!this.snapshot().fresh)
      throw new AppError(
        'Chưa có kết nối và dữ liệu mới từ máy in. Kiểm tra IP, LAN Only và Developer Mode.',
        409,
      );
  }
  async start() {
    const generation = this.generation + 1;
    await this.close();
    if (generation !== this.generation) return;
    const config = this.config.get();
    if (!config) {
      this.connection = 'unconfigured';
      this.message = 'Thêm máy in để bắt đầu.';
      return;
    }
    this.raw = {};
    this.lastReport = null;
    this.fieldReports.clear();
    this.connection = 'connecting';
    this.message = 'Đang kết nối đến máy in…';
    try {
      const certificate = await certificateAt(config.host, this.port);
      if (generation !== this.generation) return;
      if (config.fingerprint && config.fingerprint !== certificate.fingerprint) {
        this.connection = 'error';
        this.message = 'Chứng chỉ máy in đã thay đổi. Kiểm tra thiết bị trước khi kết nối lại.';
        this.event(this.message, 'error');
        return;
      }
      const client = mqtt.connect(`mqtts://${config.host}:${this.port}`, {
        username: 'bblp',
        password: config.accessCode,
        clientId: `p2s-web-${randomBytes(6).toString('hex')}`,
        protocolVersion: 4,
        clean: true,
        keepalive: 30,
        connectTimeout: 8000,
        reconnectPeriod: 10000,
        ca: certificate.pem,
        // Trust this exact device certificate even when its issuer CA is not supplied.
        allowPartialTrustChain: true,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, cert) =>
          cert.fingerprint256 === certificate.fingerprint
            ? undefined
            : new Error('CERTIFICATE_MISMATCH'),
      });
      this.client = client;
      client.on('connect', async () => {
        if (generation !== this.generation) return;
        try {
          await client.subscribeAsync(`device/${config.serial}/report`, { qos: 0 });
          if (generation !== this.generation) return;
          await this.config.pin(certificate.pem, certificate.fingerprint, config);
          if (generation !== this.generation) return;
          this.connection = 'connected';
          this.message = 'Đã kết nối MQTT. Đang chờ dữ liệu máy in.';
          this.event('Đã kết nối máy in.');
          await this.pushall();
        } catch {
          this.connection = 'error';
          this.message = 'Không đăng ký được dữ liệu máy in. Kiểm tra serial và quyền truy cập.';
        }
      });
      client.on('message', (topic, data) => {
        if (
          generation !== this.generation ||
          topic !== `device/${config.serial}/report` ||
          data.length > 1024 * 1024
        )
          return;
        try {
          const report = JSON.parse(data.toString());
          if (!report || typeof report !== 'object' || Array.isArray(report)) return;
          const previous = summarize(this.raw).status;
          this.raw = mergeReport(this.raw, report);
          const telemetry =
            report.print &&
            [
              'gcode_state',
              'mc_percent',
              'nozzle_temper',
              'bed_temper',
              'device',
              'ams',
              'wifi_signal',
              'gcode_file',
              'hms',
              'print_error',
              'sdcard',
            ].some((key) => key in report.print);
          if (telemetry) {
            this.lastReport = Date.now();
            this.message = 'Đang nhận dữ liệu từ máy in.';
            const version = ++this.reportVersion;
            for (const field of trackedFields) {
              if (!Object.hasOwn(report.print, field)) continue;
              if (validField(field, report.print[field]))
                this.fieldReports.set(field, { at: this.lastReport, version });
              else this.fieldReports.delete(field);
            }
            for (const waiter of this.reportWaiters)
              if (
                healthFields.every(
                  (field) => (this.fieldReports.get(field)?.version || 0) > waiter.since,
                )
              )
                waiter.finish();
          }
          this.maintenance.observe(report);
          const status = summarize(this.raw).status;
          if (
            this.submissionTimer &&
            telemetry &&
            ['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'].includes(status)
          )
            this.cancelSubmission();
          if (status !== previous && status !== 'UNKNOWN')
            this.event(`Trạng thái máy in: ${status}.`, status === 'FAILED' ? 'error' : 'info');
          if (report.print?.result === 'fail' || report.print?.result === 'failed') {
            if (report.print?.command === 'project_file') this.cancelSubmission();
            this.event(
              'Máy in từ chối lệnh. Kiểm tra Developer Mode và lỗi trên màn hình máy.',
              'error',
            );
          }
        } catch {
          this.event('Bỏ qua một bản tin máy in không hợp lệ.', 'error');
        }
      });
      client.on('error', (error) => {
        if (generation !== this.generation) return;
        this.connection = 'error';
        this.message = [4, 5, 134, 135].includes(error.code)
          ? 'Xác thực thất bại. Kiểm tra Access Code và Developer Mode.'
          : 'Không kết nối được máy in. Kiểm tra mạng, IP và chế độ LAN.';
      });
      client.on('offline', () => {
        if (generation === this.generation) {
          this.connection = 'offline';
          this.lastReport = null;
          this.message = 'Mất kết nối máy in. App sẽ tự thử lại.';
          this.maintenance.uncertain();
        }
      });
      client.on('reconnect', () => {
        if (generation === this.generation) {
          this.connection = 'connecting';
          this.message = 'Đang kết nối lại máy in…';
        }
      });
      this.refresh = setInterval(() => {
        if (client.connected) this.pushall().catch(() => {});
      }, 300000);
      this.refresh.unref();
    } catch {
      if (generation !== this.generation) return;
      this.connection = 'offline';
      this.message = 'Không tới được máy in qua cổng 8883. Kiểm tra IP và đường mạng từ Ubuntu.';
      this.retry = setTimeout(() => this.start().catch(() => {}), 15000);
      this.retry.unref();
    }
  }
  async publish(payload) {
    if (!this.client?.connected) throw new AppError('Máy in chưa kết nối.', 409);
    const config = this.config.get();
    let timeout;
    try {
      await Promise.race([
        this.client.publishAsync(`device/${config.serial}/request`, JSON.stringify(payload), {
          qos: 0,
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new AppError('Gửi lệnh quá thời gian chờ.', 504)),
            6000,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  holdSubmission() {
    this.cancelSubmission();
    this.jobPending = true;
    this.submissionTimer = setTimeout(() => {
      this.cancelSubmission();
      this.event(
        'Chưa nhận được trạng thái bắt đầu in sau 60 giây. Kiểm tra trực tiếp máy in trước khi gửi lại.',
        'error',
      );
    }, 60000);
    this.submissionTimer.unref();
  }
  cancelSubmission() {
    clearTimeout(this.submissionTimer);
    this.submissionTimer = null;
    this.jobPending = false;
  }
  async pushall() {
    await this.publish({ pushing: { sequence_id: String(++this.sequence), command: 'pushall' } });
  }
  async refreshStatus(timeoutMs = 10000) {
    if (!this.config.get()) throw new AppError('Chưa cấu hình máy in.', 409);
    if (this.configPending) throw new AppError('Đang thay đổi kết nối máy in.', 409);
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = {
        since: this.reportVersion,
        finish: (error) => {
          clearTimeout(timer);
          this.reportWaiters.delete(waiter);
          if (error) reject(error);
          else resolve();
        },
      };
      this.reportWaiters.add(waiter);
      timer = setTimeout(
        () =>
          waiter.finish(
            new AppError(
              'Chưa nhận được đầy đủ phản hồi trạng thái và lỗi mới từ máy in. Kiểm tra IP, serial, LAN Only và Developer Mode.',
              504,
            ),
          ),
        timeoutMs,
      );
      if (this.client?.connected) this.pushall().catch((error) => waiter.finish(error));
      // A connection in progress sends pushall after subscribing, so wait for its telemetry.
    });
  }
  async command(input) {
    this.assertReady();
    if (this.jobPending || this.configPending)
      throw new AppError('Đang gửi tác vụ in hoặc đổi kết nối. Đợi quá trình này hoàn tất.', 409);
    if (this.maintenance.active && !['stop', 'light'].includes(input.type))
      throw new AppError(
        'Đang hiệu chuẩn hoặc chưa rõ kết quả hiệu chuẩn. Kiểm tra máy trước khi thao tác.',
        409,
      );
    if (input.type === 'calibration' || input.type === 'systemCheck') {
      if (!this.snapshot().healthFresh)
        throw new AppError(
          'Cần dữ liệu trạng thái và lỗi mới từ máy in. Chạy kiểm tra kết nối trước khi hiệu chuẩn.',
          409,
        );
      if (this.queueActive)
        throw new AppError('Hàng đợi đang chạy. Hủy hàng đợi trước khi hiệu chuẩn.', 409);
      const faults =
        input.type === 'systemCheck'
          ? blockingMaintenanceFaults(this.snapshot())
          : printerFaults(this.snapshot()).filter((fault) => fault.severity === 'error');
      if (faults.length)
        throw new AppError(
          input.type === 'systemCheck'
            ? 'Còn lỗi khác trên máy. Xử lý lỗi đó trước khi kiểm tra toàn hệ thống.'
            : 'Xử lý lỗi máy in trước khi hiệu chuẩn.',
          409,
        );
    }
    const payload = makeCommand(input, ++this.sequence, summarize(this.raw).status);
    if (input.type === 'calibration' || input.type === 'systemCheck') {
      this.maintenance.begin(payload.print.sequence_id);
      try {
        await this.publish(payload);
      } catch (error) {
        this.maintenance.uncertain();
        throw error;
      }
      return;
    }
    await this.publish(payload);
    const names = {
      pause: 'tạm dừng',
      resume: 'tiếp tục',
      stop: 'dừng in',
      light: 'đổi đèn',
      speed: 'đổi tốc độ',
      nozzle: 'đổi nhiệt đầu phun',
      bed: 'đổi nhiệt bàn in',
    };
    this.event(`Đã gửi yêu cầu ${names[input.type]}. Chờ máy in cập nhật trạng thái.`);
  }
  async close() {
    this.generation++;
    clearTimeout(this.retry);
    clearInterval(this.refresh);
    this.maintenance.disconnect();
    for (const waiter of this.reportWaiters)
      waiter.finish(new AppError('Kết nối máy in đã thay đổi trong lúc kiểm tra.', 409));
    const client = this.client;
    this.client = null;
    this.connection = 'offline';
    this.lastReport = null;
    if (client) await client.endAsync(true);
  }
}
