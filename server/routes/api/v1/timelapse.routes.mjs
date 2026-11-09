import { Router } from 'express';

export function timelapseRoutes(controller) {
  const router = Router();
  router.get('/', controller.show);
  router.put('/settings', controller.settings);
  router.post('/start', controller.start);
  router.post('/:id/stop', controller.stop);
  router.post('/:id/render', controller.render);
  router.get('/:id/video', controller.video);
  router.delete('/:id', controller.remove);
  return router;
}
