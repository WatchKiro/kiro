import { createServer } from 'node:http';

import { createApp } from './app';
import { ConfigError, loadConfig } from './config/env';
import { createLogger } from './utils/logger';

function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, json: config.isProduction });
  const server = createServer(createApp({ config, logger }));

  server.listen(config.port, config.host, () => {
    logger.info(`kiro-api listening on http://${config.host}:${config.port}`, { env: config.env });
  });

  server.on('error', (error) => {
    logger.error('HTTP server error', { error });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully`);

    const forceExit = setTimeout(() => {
      logger.error(`Shutdown timed out after ${config.shutdownTimeoutMs}ms, forcing exit`);
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    // Stop accepting connections; let in-flight requests finish.
    server.close((error) => {
      if (error) {
        logger.error('Error while closing HTTP server', { error });
        process.exit(1);
      }
      logger.info('Shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: reason });
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    process.exit(1);
  });
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
