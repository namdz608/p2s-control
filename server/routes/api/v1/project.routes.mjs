import { Router } from 'express';

export function projectRoutes(controller, upload) {
  const router = Router();
  router.get('/', controller.index);
  router.get('/folders', controller.folders);
  router.post('/folders', controller.createFolder);
  router.get('/queue', controller.queueStatus);
  router.post('/queue/start', controller.startQueue);
  router.post('/queue/cancel', controller.cancelQueue);
  router.post('/', upload, controller.store);
  router.patch('/:id/folder', controller.move);
  router.get('/:id/preview', controller.preview);
  router.delete('/:id', controller.destroy);
  router.post('/:id/start', controller.start);
  return router;
}
