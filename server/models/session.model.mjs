import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_SECONDS = 12 * 3600;

export class SessionModel {
  constructor(key) {
    this.key = key;
    this.sessions = new Map();
  }

  sign(id) {
    return createHmac('sha256', this.key).update(id).digest('base64url');
  }

  find(token) {
    if (!token) return null;
    const [id, signature] = token.split('.');
    const expected = this.sign(id);
    if (
      !signature ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return null;
    const session = this.sessions.get(id);
    if (!session || session.expires < Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return id;
  }

  create() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expires < now) this.sessions.delete(id);
    }
    if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value);
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { expires: now + SESSION_TTL_SECONDS * 1000 });
    return `${id}.${this.sign(id)}`;
  }

  remove(token) {
    const id = this.find(token);
    if (id) this.sessions.delete(id);
  }
}
