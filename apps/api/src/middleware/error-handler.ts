import type { ApiFailure } from '@kiro/types';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { HttpError } from '../utils/http-error';
import type { Logger } from '../utils/logger';
import { validationError } from '../utils/validation';

/** Shape of errors raised by Express' built-in body parser. */
interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as Partial<BodyParserError>).type === 'string' &&
    typeof (error as Partial<BodyParserError>).status === 'number'
  );
}

function toHttpError(error: unknown): HttpError | null {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError) return validationError(error);
  if (isBodyParserError(error)) {
    if (error.type === 'entity.parse.failed')
      return new HttpError(400, 'INVALID_JSON', 'Malformed JSON body');
    if (error.type === 'entity.too.large')
      return new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    if (error.status >= 400 && error.status < 500)
      return new HttpError(error.status, 'BAD_REQUEST', 'Bad request');
  }
  return null;
}

/**
 * Converts every error into the standard failure envelope. Unexpected errors
 * are logged in full but reported to clients without internal details.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const httpError = toHttpError(error);
    if (!httpError) {
      logger.error('Unhandled error', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        error,
      });
    }

    const status = httpError?.status ?? 500;
    const body: ApiFailure = {
      success: false,
      error: {
        code: httpError?.code ?? 'INTERNAL_ERROR',
        message: httpError?.message ?? 'An unexpected error occurred',
        ...(httpError?.details === undefined ? {} : { details: httpError.details }),
        requestId: req.id,
      },
    };
    res.status(status).json(body);
  };
}
