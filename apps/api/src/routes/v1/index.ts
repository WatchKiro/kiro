import { Router } from 'express';

import { healthRouter } from './health.routes';

/** Routes mounted under `/api/v1`. */
export const v1Router: Router = Router();

v1Router.use('/health', healthRouter);
