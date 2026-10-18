import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import type { AppConfig } from './config/env';
import { errorHandler } from './middleware/error-handler';
import { notFound } from './middleware/not-found';
import { requestId } from './middleware/request-id';
import { requestLogger } from './middleware/request-logger';
import { v1Router } from './routes/v1';
import type { Logger } from './utils/logger';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
}

/**
 * Builds the Express application without binding a port, so tests can mount
 * it on an ephemeral port and the server entry point owns the lifecycle.
 */
export function createApp({ config, logger }: AppDependencies): Express {
  const app = express();
  const allowedOrigins = new Set(config.corsOrigins);

  app.disable('x-powered-by');

  app.use(requestId());
  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(
    cors({
      // Requests without an Origin header (curl, server-to-server) are allowed;
      // browser origins must be explicitly listed.
      origin: (origin, callback) =>
        callback(null, origin === undefined || allowedOrigins.has(origin)),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/v1', v1Router);

  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
}
