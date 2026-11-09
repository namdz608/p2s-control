import { Router } from 'express';

export function printerRoutes(controller) {
  const router = Router();
  router.get('/', controller.show);
  router.get('/config', controller.config);
  router.put('/config', controller.updateConfig);
  router.post('/reconnect', controller.reconnect);
  router.post('/commands', controller.command);
  router.post('/diagnostics', controller.diagnostics);
  router.get('/storage', controller.listStorage);
  router.delete('/storage', controller.deleteStorage);
  return router;
}
