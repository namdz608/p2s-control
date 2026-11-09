import { Router } from 'express';
import { health } from '../../../controllers/health.controller.mjs';
import { requireAuthentication } from '../../../middlewares/auth.middleware.mjs';
import { notFound } from '../../../middlewares/error.middleware.mjs';
import { authRoutes } from './auth.routes.mjs';
import { printerRoutes } from './printer.routes.mjs';
import { projectRoutes } from './project.routes.mjs';
import { cameraRoutes } from './camera.routes.mjs';
import { timelapseRoutes } from './timelapse.routes.mjs';

export function apiV1Routes({ controllers, auth, upload }) {
  const router = Router();
  router.get('/health', health);
  router.use('/auth', authRoutes(controllers.auth));
  router.use(requireAuthentication(auth));
  router.use('/printer', printerRoutes(controllers.printer));
  router.use('/projects', projectRoutes(controllers.projects, upload));
  router.use('/camera', cameraRoutes(controllers.camera));
  router.use('/timelapses', timelapseRoutes(controllers.timelapse));
  router.use(notFound);
  return router;
}
