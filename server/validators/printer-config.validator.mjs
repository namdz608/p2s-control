import { isIPv4 } from 'node:net';
import { AppError } from '../errors/app-error.mjs';

export function validateConfig(input, previous) {
  if (!input || typeof input !== 'object') throw new AppError('Thông tin kết nối không hợp lệ.');
  const host = String(input.host ?? '').trim();
  const octets = host.split('.').map(Number);
  const privateIP =
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
  if (!isIPv4(host) || !privateIP)
    throw new AppError('Nhập IPv4 nội bộ hoặc VPN của máy in, ví dụ 192.168.1.25.');
  const serial = String(input.serial ?? '').trim();
  if (!/^[A-Za-z0-9]{8,32}$/.test(serial)) throw new AppError('Số serial phải gồm 8–32 chữ và số.');
  const accessCode =
    input.accessCode ||
    (previous?.host === host && previous?.serial === serial ? previous.accessCode : '');
  if (!/^[A-Za-z0-9]{8}$/.test(accessCode))
    throw new AppError('Access Code gồm đúng 8 chữ hoặc số, lấy từ màn hình máy in.');
  const name = String(input.name || 'Bambu Lab P2S')
    .trim()
    .slice(0, 60);
  return { name, host, serial, accessCode };
}
