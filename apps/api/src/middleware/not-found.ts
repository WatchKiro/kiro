import type { RequestHandler } from 'express';

import { HttpError } from '../utils/http-error';

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};
