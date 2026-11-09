export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

export function requireSameOrigin(publicOrigin = '') {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    try {
      const origin = new URL(req.headers.origin ?? '');
      if (
        publicOrigin
          ? origin.origin !== new URL(publicOrigin).origin
          : origin.host !== req.headers.host
      )
        throw new Error();
    } catch {
      return res.status(403).json({ error: 'Yêu cầu phải gửi từ chính trang web này.' });
    }
    next();
  };
}
