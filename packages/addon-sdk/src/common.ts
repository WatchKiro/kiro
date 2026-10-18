import { z } from 'zod';

/**
 * Hard limits applied to all addon data. Addons are untrusted remote services,
 * so every string and list is bounded to keep a misbehaving addon from
 * exhausting memory or flooding the UI.
 */
export const ADDON_LIMITS = {
  idLength: 512,
  shortText: 256,
  longText: 10_000,
  urlLength: 2048,
  catalogItems: 1000,
  streams: 500,
  subtitles: 500,
  videos: 10_000,
} as const;

/** Absolute http(s) URL. Rejects `javascript:`, `file:`, `data:` and other schemes. */
export const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(ADDON_LIMITS.urlLength);

/**
 * Absolute https URL, for files the player fetches itself (subtitles): the
 * native player refuses anything else.
 */
export const httpsUrlSchema = z.url({ protocol: /^https$/ }).max(ADDON_LIMITS.urlLength);

export const idSchema = z.string().min(1).max(ADDON_LIMITS.idLength);
export const shortTextSchema = z.string().max(ADDON_LIMITS.shortText);
export const longTextSchema = z.string().max(ADDON_LIMITS.longText);

/**
 * Content type such as `movie` or `series`. Kept open-ended so that new types
 * introduced by addons do not invalidate otherwise valid responses.
 */
export const contentTypeSchema = z.string().min(1).max(64);

/**
 * Makes an optional, non-essential field lenient: an invalid value is dropped
 * (becomes `undefined`) instead of rejecting the whole object.
 */
export function lenient<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

/**
 * A lenient, bounded list: invalid items are skipped and anything past `max`
 * is ignored, instead of one bad or surplus entry rejecting the whole list.
 * Anything other than an array becomes `undefined`.
 */
export function lenientList<T extends z.ZodType>(item: T, max: number) {
  return z
    .unknown()
    .transform((value) => (Array.isArray(value) ? keepValid(item, value.slice(0, max)) : undefined))
    .optional();
}

function keepValid<T extends z.ZodType>(item: T, values: unknown[]): z.output<T>[] {
  const items: z.output<T>[] = [];
  for (const value of values) {
    const parsed = item.safeParse(value);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}
