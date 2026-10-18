import type { RequestHandler } from 'express';

import type { Logger } from '../utils/logger';

/** Logs one line per completed request. Query strings are omitted to avoid logging tokens. */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    // Captured now: Express rewrites req.path relative to each mounted router.
    const { method, path } = req;

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level](`${method} ${path} ${res.statusCode}`, {
        requestId: req.id,
        durationMs: Math.round(durationMs * 10) / 10,
      });
    });

    next();
  };
}
