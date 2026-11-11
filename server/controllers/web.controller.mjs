import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function assetVersion(name) {
  return createHash('sha256')
    .update(readFileSync(new URL(`../../public/${name}`, import.meta.url)))
    .digest('hex')
    .slice(0, 16);
}

const html = readFileSync(new URL('../views/index.html', import.meta.url), 'utf8')
  .replace('__APP_JS_VERSION__', assetVersion('app.js'))
  .replace('__STYLE_CSS_VERSION__', assetVersion('style.css'));

export function home(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
}
