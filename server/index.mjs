import { createRuntime } from './bootstrap.mjs';

const { app, printer, projects, timelapse, port } = await createRuntime();
const server = app.listen(port, '0.0.0.0', () =>
  console.log(`P2S Control đã sẵn sàng tại cổng ${port}`),
);
server.requestTimeout = 10 * 60000;
server.headersTimeout = 15000;
void printer.start().catch(() => {});
timelapse.watch();

const shutdown = async () => {
  projects.queue.cancel();
  await timelapse.close();
  await printer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
