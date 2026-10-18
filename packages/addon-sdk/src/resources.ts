import { z } from 'zod';

import {
  ADDON_LIMITS,
  contentTypeSchema,
  httpUrlSchema,
  httpsUrlSchema,
  idSchema,
  lenient,
  lenientList,
  longTextSchema,
  shortTextSchema,
} from './common';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metaPreviewSchema = z.object({
  id: idSchema,
  type: contentTypeSchema,
  name: z.string().min(1).max(ADDON_LIMITS.shortText),
  poster: lenient(httpUrlSchema),
  posterShape: lenient(z.enum(['poster', 'landscape', 'square'])),
  description: lenient(longTextSchema),
  releaseInfo: lenient(shortTextSchema),
  imdbRating: lenient(shortTextSchema),
  genres: lenient(z.array(shortTextSchema).max(32)),
  /** Artwork for a hero or wide card. Catalogues may send it; details usually do. */
  background: lenient(httpUrlSchema),
  /** The title's logo artwork, drawn in place of its name. */
  logo: lenient(httpUrlSchema),
  runtime: lenient(shortTextSchema),
});
export type MetaPreview = z.infer<typeof metaPreviewSchema>;

export const videoSchema = z.object({
  id: idSchema,
  title: lenient(shortTextSchema),
  /** Legacy alias of `title`, still sent by Cinemeta. */
  name: lenient(shortTextSchema),
  released: lenient(shortTextSchema),
  season: lenient(z.number().int().nonnegative()),
  episode: lenient(z.number().int().nonnegative()),
  thumbnail: lenient(httpUrlSchema),
  overview: lenient(longTextSchema),
});
export type Video = z.infer<typeof videoSchema>;

export const metaDetailSchema = metaPreviewSchema.extend({
  released: lenient(shortTextSchema),
  videos: lenient(z.array(videoSchema).max(ADDON_LIMITS.videos)),
});
export type MetaDetail = z.infer<typeof metaDetailSchema>;

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

/**
 * A subtitle file from an addon (the `subtitles` resource, or a stream's
 * `subtitles`). Only https files are kept: the player fetches them itself.
 * Addons that leave out the id get the URL as one, and a missing or
 * unreadable language becomes `und` (undetermined).
 */
export const subtitleSchema = z
  .object({
    id: lenient(idSchema),
    url: httpsUrlSchema,
    /** ISO 639-2 code or BCP 47 language tag, as sent; some addons send a name. */
    lang: lenient(z.string().trim().min(2).max(35)),
    label: lenient(shortTextSchema),
  })
  .transform(({ id, url, lang, label }) => ({
    id: id ?? url,
    url,
    lang: lang ?? 'und',
    ...(label === undefined ? {} : { label }),
  }));
export type Subtitle = z.infer<typeof subtitleSchema>;

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

export const streamSchema = z
  .object({
    url: lenient(httpUrlSchema),
    ytId: lenient(z.string().regex(/^[\w-]{11}$/)),
    infoHash: lenient(z.string().regex(/^[a-fA-F0-9]{40}$/)),
    fileIdx: lenient(z.number().int().nonnegative()),
    externalUrl: lenient(httpUrlSchema),
    name: lenient(shortTextSchema),
    description: lenient(longTextSchema),
    /** Deprecated alias of `description`, still sent by many addons. */
    title: lenient(longTextSchema),
    /** Subtitles that come with the stream; invalid entries are skipped. */
    subtitles: lenientList(subtitleSchema, ADDON_LIMITS.subtitles),
    behaviorHints: lenient(
      z.object({
        notWebReady: z.boolean().optional(),
        bingeGroup: shortTextSchema.optional(),
        filename: shortTextSchema.optional(),
        videoSize: z.number().int().nonnegative().optional(),
      }),
    ),
  })
  .refine((stream) => Boolean(stream.url ?? stream.ytId ?? stream.infoHash ?? stream.externalUrl), {
    message: 'A stream must provide a url, ytId, infoHash or externalUrl',
  });
export type Stream = z.infer<typeof streamSchema>;
