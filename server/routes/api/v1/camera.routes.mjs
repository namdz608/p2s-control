import { Router } from 'express';

export function cameraRoutes(controller) {
  const router = Router();
  router.get('/snapshot', controller.snapshot);
  router.get('/stream', controller.stream);
  return router;
}
