import type { KnownApiErrorCode } from '@kiro/types';

/**
 * An error whose message is safe to return to clients. Anything that is not an
 * `HttpError` is reported to clients as a generic 500.
 */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly status: number;
  readonly code: KnownApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: KnownApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
