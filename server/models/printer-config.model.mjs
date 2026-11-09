import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';
import { validateConfig } from '../validators/printer-config.validator.mjs';
import { atomicWrite } from '../utils/atomic-file.mjs';

export class ConfigStore {
  static async open(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const keyPath = path.join(directory, 'master.key');
    try {
      await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const key = await readFile(keyPath);
    if (key.length !== 32) throw new Error('Khóa dữ liệu không hợp lệ.');
    const store = new ConfigStore(directory, key);
    try {
      const saved = JSON.parse(await readFile(store.file, 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.secret.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(saved.secret.tag, 'hex'));
      const accessCode = Buffer.concat([
        decipher.update(Buffer.from(saved.secret.data, 'hex')),
        decipher.final(),
      ]).toString();
      store.value = { ...saved.printer, accessCode };
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(
          'Không đọc được cấu hình máy in. Giữ lại cả master.key khi phục hồi dữ liệu.',
        );
    }
    return store;
  }
  constructor(directory, key) {
    this.directory = directory;
    this.key = key;
    this.file = path.join(directory, 'printer.json');
    this.value = null;
    this.pendingWrite = Promise.resolve();
  }
  get() {
    return this.value ? { ...this.value } : null;
  }
  public() {
    if (!this.value)
      return {
        configured: false,
        name: 'Bambu Lab P2S',
        host: '',
        serial: '',
        hasAccessCode: false,
      };
    const { accessCode, certificate, ...value } = this.value;
    return { ...value, configured: true, hasAccessCode: Boolean(accessCode) };
  }
  async persist() {
    const { accessCode, ...printer } = this.value;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(accessCode, 'utf8'), cipher.final()]);
    const saved = JSON.stringify({
      printer,
      secret: {
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        data: data.toString('hex'),
      },
    });
    this.pendingWrite = this.pendingWrite.catch(() => {}).then(() => atomicWrite(this.file, saved));
    await this.pendingWrite;
  }
  async save(input) {
    const next = validateConfig(input, this.value);
    if (this.value?.host === next.host && this.value?.serial === next.serial) {
      next.certificate = this.value.certificate;
      next.fingerprint = this.value.fingerprint;
    }
    this.value = next;
    await this.persist();
  }
  async pin(certificate, fingerprint, identity) {
    if (
      identity &&
      (identity.host !== this.value?.host ||
        identity.serial !== this.value?.serial ||
        identity.accessCode !== this.value?.accessCode)
    )
      return false;
    this.value = { ...this.value, certificate, fingerprint };
    await this.persist();
    return true;
  }
}
