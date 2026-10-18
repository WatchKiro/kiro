import { z } from 'zod';

/** Content types Kiro understands natively. */
export const MEDIA_TYPES = ['movie', 'series'] as const;
export const mediaTypeSchema = z.enum(MEDIA_TYPES);
export type MediaType = z.infer<typeof mediaTypeSchema>;

/**
 * Opaque, provider-scoped media identifier (e.g. `tt0111161`, `tmdb:278`).
 * Kiro never parses the inner structure outside of the provider that issued it.
 */
export const mediaIdSchema = z.string().trim().min(1).max(256).brand<'MediaId'>();
export type MediaId = z.infer<typeof mediaIdSchema>;

/** IMDb title identifier, the most widely shared cross-provider key. */
export const imdbIdSchema = z
  .string()
  .regex(/^tt\d{7,10}$/, 'Expected an IMDb id such as tt0111161');
export type ImdbId = z.infer<typeof imdbIdSchema>;

/** Minimal representation of a title used in lists, grids and search results. */
export const mediaSummarySchema = z.object({
  id: mediaIdSchema,
  type: mediaTypeSchema,
  title: z.string().min(1),
  year: z.number().int().min(1870).max(2200).optional(),
  posterUrl: z.url({ protocol: /^https?$/ }).optional(),
});
export type MediaSummary = z.infer<typeof mediaSummarySchema>;
