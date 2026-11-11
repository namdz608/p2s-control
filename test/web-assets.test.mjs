import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { home } from '../server/controllers/web.controller.mjs';

async function serve(t, handler) {
  const app = express();
  app.get('/', handler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the page prevents stale HTML and versions scripts and styles by asset content', async (t) => {
  const origin = await serve(t, home);
  const response = await fetch(origin);
  const html = await response.text();
  assert.match(html.match(/<script[^>]+src="([^"]+)"/)[1], /^\/app\.js\?v=[a-f0-9]{16}$/);
  assert.match(html.match(/href="(\/style\.css[^"]+)"/)[1], /^\/style\.css\?v=[a-f0-9]{16}$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('a release changes only the URLs of assets whose contents changed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'p2s-asset-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'server', 'controllers'), { recursive: true });
  await mkdir(path.join(directory, 'server', 'views'), { recursive: true });
  await mkdir(path.join(directory, 'public'));
  const controller = path.join(directory, 'server', 'controllers', 'web.controller.mjs');
  await copyFile(new URL('../server/controllers/web.controller.mjs', import.meta.url), controller);
  await copyFile(
    new URL('../server/views/index.html', import.meta.url),
    path.join(directory, 'server', 'views', 'index.html'),
  );
  const script = path.join(directory, 'public', 'app.js');
  const style = path.join(directory, 'public', 'style.css');
  await writeFile(script, 'console.log("original");');
  await writeFile(style, 'body { color: black; }');
  const renderRelease = async (release) => {
    const { home: handler } = await import(`${pathToFileURL(controller).href}?release=${release}`);
    const origin = await serve(t, handler);
    const html = await (await fetch(origin)).text();
    return {
      script: html.match(/<script[^>]+src="([^"]+)"/)[1],
      style: html.match(/href="(\/style\.css[^"]+)"/)[1],
    };
  };
  const original = await renderRelease('original');
  await writeFile(script, 'console.log("folder click handler added");');
  const newScript = await renderRelease('new-script');
  assert.notEqual(
    newScript.script,
    original.script,
    'new behavior must bypass previously cached JavaScript',
  );
  assert.equal(newScript.style, original.style);
  await writeFile(style, 'body { color: orange; }');
  const newStyle = await renderRelease('new-style');
  assert.equal(newStyle.script, newScript.script);
  assert.notEqual(newStyle.style, newScript.style);
});
