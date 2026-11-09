import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AuthService } from '../server/services/auth.service.mjs';

test('an eight-character configured password authenticates and shorter passwords are rejected', () => {
  const key = randomBytes(32);
  const password = 'a7'.repeat(4);
  const auth = new AuthService(password, key);
  const login = auth.login(password, '127.0.0.1');
  assert.ok(auth.session(login.token));
  assert.throws(() => auth.login('b8'.repeat(4), '127.0.0.1'), /Mật khẩu không đúng/);
  assert.throws(() => new AuthService('a'.repeat(7), key), /8 ký tự/);
});
