import { Router } from 'express';
import { health } from '../controllers/health.controller.mjs';
import { requireAuthentication } from '../middlewares/auth.middleware.mjs';
import { authRoutes } from './api/v1/auth.routes.mjs';
import { projectRoutes } from './api/v1/project.routes.mjs';
import { cameraRoutes } from './api/v1/camera.routes.mjs';

// Compatibility URLs share controllers, guards and services with API v1.
export function legacyApiRoutes({ controllers, auth, upload }) {
  const router = Router();
  router.get('/health', health);
  router.use('/auth', authRoutes(controllers.auth));
  router.use(requireAuthentication(auth));
  router.get('/state', controllers.printer.show);
  router.get('/config', controllers.printer.config);
  router.post('/config', controllers.printer.updateConfig);
  router.post('/reconnect', controllers.printer.reconnect);
  router.post('/commands', controllers.printer.command);
  router.use('/projects', projectRoutes(controllers.projects, upload));
  router.use('/camera', cameraRoutes(controllers.camera));
  return router;
}
