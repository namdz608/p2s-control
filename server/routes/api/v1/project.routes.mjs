import { Router } from 'express';

export function projectRoutes(controller, upload) {
  const router = Router();
  router.get('/', controller.index);
  router.get('/queue', controller.queueStatus);
  router.post('/queue/start', controller.startQueue);
  router.post('/queue/cancel', controller.cancelQueue);
  router.post('/', upload, controller.store);
  router.delete('/:id', controller.destroy);
  router.post('/:id/start', controller.start);
  return router;
}
