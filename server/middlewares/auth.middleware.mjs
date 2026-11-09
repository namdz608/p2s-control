export function sessionToken(req) {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('p2s_session='))
    ?.slice(12);
}

export function requireAuthentication(auth) {
  return (req, res, next) => {
    if (auth.session(sessionToken(req))) return next();
    res.status(401).json({ error: 'Cần đăng nhập để tiếp tục.' });
  };
}
