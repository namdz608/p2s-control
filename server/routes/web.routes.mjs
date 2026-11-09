import { Router } from 'express';
import { home } from '../controllers/web.controller.mjs';

export function webRoutes() {
  const router = Router();
  router.get('/', home);
  return router;
}
