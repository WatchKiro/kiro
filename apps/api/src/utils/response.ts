import type { ApiSuccess } from '@kiro/types';
import type { Response } from 'express';

/** Sends a success envelope: `{ success: true, data }`. */
export function sendSuccess<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccess<T> = { success: true, data };
  res.status(status).json(body);
}
