import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors/app-error.mjs';
import { SessionModel, SESSION_TTL_SECONDS } from '../models/session.model.mjs';

export class AuthService {
  constructor(password, key) {
    if (
      typeof password !== 'string' ||
      password.length < 8 ||
      /change.?me|your.?password/i.test(password)
    ) {
      throw new Error('APP_PASSWORD phải dài ít nhất 8 ký tự và không dùng mật khẩu mẫu.');
    }
    this.salt = randomBytes(16);
    this.hash = scryptSync(password, this.salt, 32);
    this.sessions = new SessionModel(key);
    this.attempts = new Map();
  }

  session(token) {
    return this.sessions.find(token);
  }

  login(password, ip) {
    const now = Date.now();
    for (const [key, value] of this.attempts) {
      if (value.until < now) this.attempts.delete(key);
    }
    const attempt = this.attempts.get(ip) ?? { count: 0, until: now + 900000 };
    if (attempt.count >= 10)
      throw new AppError('Đăng nhập sai nhiều lần. Thử lại sau 15 phút.', 429);
    attempt.count++;
    this.attempts.set(ip, attempt);
    if (
      typeof password !== 'string' ||
      password.length > 256 ||
      !timingSafeEqual(scryptSync(password, this.salt, 32), this.hash)
    ) {
      throw new AppError('Mật khẩu không đúng.', 401);
    }
    this.attempts.delete(ip);
    return { token: this.sessions.create(), maxAge: SESSION_TTL_SECONDS };
  }

  logout(token) {
    this.sessions.remove(token);
  }
}
