import { Router } from 'express';

import { getHealth } from '../../controllers/health.controller';

export const healthRouter: Router = Router();

healthRouter.get('/', getHealth);
