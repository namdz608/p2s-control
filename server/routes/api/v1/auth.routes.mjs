import { Router } from 'express';

export function authRoutes(controller) {
  const router = Router();
  router.get('/session', controller.session);
  router.post('/login', controller.login);
  router.post('/logout', controller.logout);
  return router;
}
