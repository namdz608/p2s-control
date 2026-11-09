import express from 'express';
import { fileURLToPath } from 'node:url';
import { AuthService } from './services/auth.service.mjs';
import { PrinterConfigService } from './services/printer-config.service.mjs';
import { AuthController } from './controllers/auth.controller.mjs';
import { PrinterController } from './controllers/printer.controller.mjs';
import { ProjectController } from './controllers/project.controller.mjs';
import { CameraController } from './controllers/camera.controller.mjs';
import { TimelapseController } from './controllers/timelapse.controller.mjs';
import { securityHeaders, requireSameOrigin } from './middlewares/security.middleware.mjs';
import { projectUpload } from './middlewares/upload.middleware.mjs';
import { notFound, errorHandler } from './middlewares/error.middleware.mjs';
import { apiV1Routes } from './routes/api/v1/index.mjs';
import { legacyApiRoutes } from './routes/legacy-api.routes.mjs';
import { webRoutes } from './routes/web.routes.mjs';

const publicDirectory = fileURLToPath(new URL('../public', import.meta.url));

export function createApp({
  config,
  printer,
  projects,
  camera,
  timelapse,
  storage,
  password,
  secureCookies = false,
  publicOrigin = '',
}) {
  const auth = new AuthService(password, config.key);
  const settings = new PrinterConfigService(config, printer, camera, timelapse);
  const context = {
    auth,
    upload: projectUpload(config.directory),
    controllers: {
      auth: new AuthController(auth, secureCookies),
      printer: new PrinterController(
        printer,
        settings,
        projects.queue,
        timelapse,
        storage,
        projects,
      ),
      projects: new ProjectController(projects),
      camera: new CameraController(camera),
      timelapse: new TimelapseController(timelapse),
    },
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use('/api', requireSameOrigin(publicOrigin));
  app.use(express.json({ limit: '32kb' }));
  app.use('/api/v1', apiV1Routes(context));
  app.use('/api', legacyApiRoutes(context));
  app.use(webRoutes());
  app.use(express.static(publicDirectory, { dotfiles: 'deny', index: false, maxAge: 0 }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
