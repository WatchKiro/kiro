/** Error codes produced by the client itself rather than returned by the API. */
export type ClientErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED' | 'INVALID_RESPONSE';

export interface KiroApiErrorInit {
  /** API error code (see `KnownApiErrorCode`) or a `ClientErrorCode`. */
  code: string;
  message: string;
  /** HTTP status, or `null` when no response was received. */
  status: number | null;
  details?: unknown;
  requestId?: string;
  cause?: unknown;
}

export class KiroApiError extends Error {
  override readonly name = 'KiroApiError';
  readonly code: string;
  readonly status: number | null;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor({ code, message, status, details, requestId, cause }: KiroApiErrorInit) {
    super(message, { cause });
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

export function isKiroApiError(error: unknown): error is KiroApiError {
  return error instanceof KiroApiError;
}
