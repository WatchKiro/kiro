import { apiResponseSchema, healthDataSchema } from '@kiro/types';
import { z } from 'zod';

import { KiroApiError } from './errors';

export const API_PREFIX = '/api/v1';

/** Validates the envelope only; `data` is validated separately against the caller's schema. */
const envelopeSchema = apiResponseSchema(z.unknown());

export interface KiroApiClientOptions {
  /** Origin of the Kiro API, e.g. `http://localhost:4000`. The `/api/v1` prefix is added automatically. */
  baseUrl: string;
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds, covering both the request and reading the body. */
  timeoutMs?: number;
}

export interface RequestOptions<TSchema extends z.ZodType> {
  /** Schema for the `data` field of a successful response. Responses are always validated. */
  schema: TSchema;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON-serialisable request body. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createKiroApiClient(options: KiroApiClientOptions) {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<TSchema extends z.ZodType>(
    path: `/${string}`,
    { schema, method = 'GET', body, headers, signal }: RequestOptions<TSchema>,
  ): Promise<z.output<TSchema>> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) controller.abort();

    const fail = (cause: unknown): never => {
      if (timedOut) {
        throw new KiroApiError({
          code: 'TIMEOUT',
          message: `Request timed out after ${timeoutMs}ms`,
          status: null,
          cause,
        });
      }
      if (signal?.aborted) {
        throw new KiroApiError({
          code: 'ABORTED',
          message: 'Request was aborted',
          status: null,
          cause,
        });
      }
      throw new KiroApiError({
        code: 'NETWORK_ERROR',
        message: 'Unable to reach the Kiro API',
        status: null,
        cause,
      });
    };

    try {
      const response = await fetchImpl(`${baseUrl}${API_PREFIX}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...options.headers,
          ...headers,
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: controller.signal,
      }).catch(fail);

      const payload: unknown = await response.json().catch((cause: unknown) => {
        if (controller.signal.aborted) fail(cause);
        throw new KiroApiError({
          code: 'INVALID_RESPONSE',
          message: `Expected a JSON response (HTTP ${response.status})`,
          status: response.status,
          cause,
        });
      });

      const invalid = (issues: z.core.$ZodIssue[]) =>
        new KiroApiError({
          code: 'INVALID_RESPONSE',
          message: 'The Kiro API returned an unexpected response',
          status: response.status,
          details: issues,
        });

      const envelope = envelopeSchema.safeParse(payload);
      if (!envelope.success) throw invalid(envelope.error.issues);

      if (!envelope.data.success) {
        const { code, message, details, requestId } = envelope.data.error;
        throw new KiroApiError({ code, message, details, requestId, status: response.status });
      }

      const data = schema.safeParse(envelope.data.data);
      if (!data.success) throw invalid(data.error.issues);
      return data.data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  return {
    request,
    /** `GET /api/v1/health` */
    health: (signal?: AbortSignal) =>
      request('/health', { schema: healthDataSchema, ...(signal ? { signal } : {}) }),
  };
}

export type KiroApiClient = ReturnType<typeof createKiroApiClient>;

function normaliseBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError(`Invalid Kiro API base URL: "${input}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`Kiro API base URL must use http or https, received "${url.protocol}"`);
  }
  return url.href.replace(/\/+$/, '');
}
