import { z } from 'zod';

/**
 * Every Kiro API response uses one envelope:
 *
 *   { "success": true,  "data": T }
 *   { "success": false, "error": { "code", "message", "details"?, "requestId"? } }
 */

export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'INVALID_JSON',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
] as const;

/** Known error codes. Clients must tolerate codes they do not recognise. */
export type KnownApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  requestId: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const apiFailureSchema = z.object({
  success: z.literal(false),
  error: apiErrorSchema,
});
export type ApiFailure = z.infer<typeof apiFailureSchema>;

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({ success: z.literal(true), data });
}

export function apiResponseSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('success', [apiSuccessSchema(data), apiFailureSchema]);
}

// ---------------------------------------------------------------------------
// GET /api/v1/health
// ---------------------------------------------------------------------------

export const healthDataSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
});
export type HealthData = z.infer<typeof healthDataSchema>;
