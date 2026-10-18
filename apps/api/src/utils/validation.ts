import type { z } from 'zod';

import { HttpError } from './http-error';

/**
 * Validates untrusted request input (body, query, params) against a schema and
 * returns the typed result, or throws a 400 `VALIDATION_ERROR`.
 *
 *   const query = parseInput(listQuerySchema, req.query);
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function validationError(error: z.ZodError): HttpError {
  return new HttpError(400, 'VALIDATION_ERROR', 'Request validation failed', {
    issues: error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  });
}
