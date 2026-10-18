import { z } from 'zod';

import { ADDON_LIMITS } from './common';
import { addonManifestSchema, type AddonManifest } from './manifest';
import {
  metaDetailSchema,
  metaPreviewSchema,
  streamSchema,
  subtitleSchema,
  type MetaDetail,
  type MetaPreview,
  type Stream,
  type Subtitle,
} from './resources';

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Result of validating untrusted addon data. Never throws.
 *
 * For list responses, individual invalid items are skipped rather than
 * failing the whole response; `dropped` reports how many were discarded.
 */
export type ParseResult<T> =
  { ok: true; value: T; dropped: number } | { ok: false; issues: ValidationIssue[] };

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseObject<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data, dropped: 0 }
    : { ok: false, issues: toIssues(result.error) };
}

function parseList<K extends string, T>(
  key: K,
  item: z.ZodType<T>,
  max: number,
  input: unknown,
): ParseResult<Record<K, T[]>> {
  const envelope = z.object({ [key]: z.array(z.unknown()).max(max) }).safeParse(input);
  if (!envelope.success) return { ok: false, issues: toIssues(envelope.error) };

  const raw = envelope.data[key] as unknown[];
  const items: T[] = [];
  for (const candidate of raw) {
    const parsed = item.safeParse(candidate);
    if (parsed.success) items.push(parsed.data);
  }
  return {
    ok: true,
    value: { [key]: items } as Record<K, T[]>,
    dropped: raw.length - items.length,
  };
}

export function parseManifest(input: unknown): ParseResult<AddonManifest> {
  return parseObject(addonManifestSchema, input);
}

export function parseCatalogResponse(input: unknown): ParseResult<{ metas: MetaPreview[] }> {
  return parseList('metas', metaPreviewSchema, ADDON_LIMITS.catalogItems, input);
}

export function parseMetaResponse(input: unknown): ParseResult<{ meta: MetaDetail }> {
  return parseObject(z.object({ meta: metaDetailSchema }), input);
}

export function parseStreamResponse(input: unknown): ParseResult<{ streams: Stream[] }> {
  return parseList('streams', streamSchema, ADDON_LIMITS.streams, input);
}

/**
 * Parses a `subtitles` resource response leniently: invalid entries (non-https
 * URLs included) are skipped, and entries past `ADDON_LIMITS.subtitles` are
 * ignored rather than failing the response. Both count as `dropped`.
 */
export function parseSubtitlesResponse(input: unknown): ParseResult<{ subtitles: Subtitle[] }> {
  const envelope = z.object({ subtitles: z.array(z.unknown()) }).safeParse(input);
  if (!envelope.success) return { ok: false, issues: toIssues(envelope.error) };
  const raw = envelope.data.subtitles;
  const result = parseList('subtitles', subtitleSchema, ADDON_LIMITS.subtitles, {
    subtitles: raw.slice(0, ADDON_LIMITS.subtitles),
  });
  return result.ok ? { ...result, dropped: raw.length - result.value.subtitles.length } : result;
}
