import { fileURLToPath } from 'node:url';

const indexView = fileURLToPath(new URL('../views/index.html', import.meta.url));

export function home(_req, res) {
  res.sendFile(indexView);
}
