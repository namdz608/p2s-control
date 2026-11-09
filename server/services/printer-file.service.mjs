import { Client } from 'basic-ftp';
import { AppError } from '../errors/app-error.mjs';

async function openPrinterFtp(config) {
  const client = new Client(30000);
  try {
    await client.access({
      host: config.host,
      port: 990,
      user: 'bblp',
      password: config.accessCode,
      secure: 'implicit',
      secureOptions: { rejectUnauthorized: false },
    });
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function uploadPrinterFile(config, localFile, remoteFile) {
  const client = await openPrinterFtp(config);
  try {
    await client.uploadFrom(localFile, remoteFile);
  } finally {
    client.close();
  }
}

export async function withPrinterFtp(config, task, { utf8 = false } = {}) {
  if (!config?.host || !config?.accessCode)
    throw new AppError('Chưa lưu máy in. Vào Kết nối máy in trước khi kiểm tra USB.', 409);
  let client;
  try {
    client = await openPrinterFtp(config);
    if (utf8) {
      try {
        await client.send('OPTS UTF8 ON');
      } catch {
        // Một số firmware bỏ qua OPTS; LIST vẫn đọc được tên tệp.
      }
    }
    return await task(client);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'Không truy cập được USB máy in qua FTPS cổng 990. Kiểm tra Developer Mode, USB và kết nối.',
      502,
    );
  } finally {
    client?.close();
  }
}
