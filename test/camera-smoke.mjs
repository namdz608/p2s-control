// Run in the web container. Uses generated video only; never contacts a printer.
const base = 'http://camera:1984';
const put = async (name, sources) => {
  const params = new URLSearchParams({ name });
  for (const src of sources) params.append('src', src);
  const response = await fetch(`${base}/api/streams?${params}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(
      `Synthetic camera configuration: HTTP ${response.status}: ${await response.text()}`,
    );
};
try {
  await put('qa_source', ['ffmpeg:virtual?video=testsrc&size=1920x1080&rate=30#video=h264']);
  await put('qa_bridge', ['rtsp://127.0.0.1:8554/qa_source', 'ffmpeg:qa_bridge#video=mjpeg']);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20000);
  const response = await fetch(`${base}/api/stream.mjpeg?src=qa_bridge`, { signal: abort.signal });
  const reader = response.body.getReader();
  let content = Buffer.alloc(0);
  let start = -1;
  let end = -1;
  while (content.length < 2 * 1024 * 1024) {
    const part = await reader.read();
    if (part.done) break;
    content = Buffer.concat([content, Buffer.from(part.value)]);
    start = content.indexOf(Buffer.from([255, 216]));
    if (start >= 0) end = content.indexOf(Buffer.from([255, 217]), start + 2);
    if (end >= 0) break;
  }
  await reader.cancel();
  clearTimeout(timeout);
  abort.abort();
  const bytes = start >= 0 && end >= 0 ? content.subarray(start, end + 2) : Buffer.alloc(0);
  let dimensions;
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 255) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      dimensions = { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      break;
    }
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  console.log(
    JSON.stringify({
      test: 'H264 via RTSP to MJPEG camera',
      status: response.status,
      type: response.headers.get('content-type'),
      bytes: bytes.length,
      dimensions,
    }),
  );
  if (!response.ok || dimensions?.width !== 960 || dimensions?.height !== 540)
    throw new Error('Camera output did not match 960x540 JPEG');
} finally {
  for (const src of ['qa_bridge', 'qa_source'])
    await fetch(`${base}/api/streams?${new URLSearchParams({ src })}`, { method: 'DELETE' });
}
