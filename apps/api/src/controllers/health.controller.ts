import type { HealthData } from '@kiro/types';
import type { RequestHandler } from 'express';

import { sendSuccess } from '../utils/response';

export const SERVICE_NAME = 'kiro-api';

export const getHealth: RequestHandler = (_req, res) => {
  sendSuccess<HealthData>(res, { status: 'ok', service: SERVICE_NAME });
};
