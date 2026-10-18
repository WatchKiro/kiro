export type PlayerErrorCode =
  | 'BACKEND_UNAVAILABLE'
  | 'UNSUPPORTED_SOURCE'
  | 'NOT_LOADED'
  | 'NETWORK'
  | 'DECODE'
  | 'TRACK_NOT_FOUND'
  | 'DESTROYED'
  | 'UNKNOWN';

export class PlayerError extends Error {
  override readonly name = 'PlayerError';
  readonly code: PlayerErrorCode;
  /** Whether retrying (or reloading the source) may succeed. */
  readonly recoverable: boolean;

  constructor(
    code: PlayerErrorCode,
    message: string,
    options?: { recoverable?: boolean; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.code = code;
    this.recoverable = options?.recoverable ?? false;
  }
}
