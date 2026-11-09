import { sessionToken } from '../middlewares/auth.middleware.mjs';

export class AuthController {
  constructor(auth, secureCookies = false) {
    this.auth = auth;
    this.secureCookies = secureCookies;
  }

  cookie(value, maxAge) {
    return `p2s_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${this.secureCookies ? '; Secure' : ''}`;
  }

  session = (req, res) => {
    res.json({ authenticated: Boolean(this.auth.session(sessionToken(req))) });
  };

  login = (req, res) => {
    const { token, maxAge } = this.auth.login(req.body?.password, req.ip);
    res.setHeader('Set-Cookie', this.cookie(token, maxAge));
    res.json({ ok: true });
  };

  logout = (req, res) => {
    this.auth.logout(sessionToken(req));
    res.setHeader('Set-Cookie', this.cookie('', 0));
    res.json({ ok: true });
  };
}
