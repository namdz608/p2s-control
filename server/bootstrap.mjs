import { ConfigStore } from './models/printer-config.model.mjs';
import { PrinterService } from './services/printer.service.mjs';
import { ProjectService } from './services/project.service.mjs';
import { CameraService } from './services/camera.service.mjs';
import { TimelapseService } from './services/timelapse.service.mjs';
import { createApp } from './app.mjs';

export async function createRuntime(environment = process.env) {
  const directory = environment.DATA_DIR || '/app/data';
  const config = await ConfigStore.open(directory);
  const printer = new PrinterService(config);
  const projects = await ProjectService.open(directory, printer, config);
  const camera = new CameraService(
    config,
    environment.CAMERA_CONFIG_DIR || '/app/camera',
    environment.CAMERA_URL || 'http://camera:1984',
  );
  await camera.init();
  const timelapse = await TimelapseService.open(directory, {
    camera,
    printer,
    queue: projects.queue,
  });
  const password = environment.APP_PASSWORD_BASE64
    ? Buffer.from(environment.APP_PASSWORD_BASE64, 'base64').toString('utf8')
    : environment.APP_PASSWORD;
  const app = createApp({
    config,
    printer,
    projects,
    camera,
    timelapse,
    password,
    secureCookies: environment.SECURE_COOKIES === 'true',
    publicOrigin: environment.PUBLIC_ORIGIN || '',
  });
  return { app, printer, projects, timelapse, port: Number(environment.PORT || 3080) };
}
