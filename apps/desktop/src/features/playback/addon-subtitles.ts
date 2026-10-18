/**
 * Subtitles from addons: the `subtitles` resource of every installed addon
 * that has it (e.g. OpenSubtitles v3), plus the ones a stream comes with.
 *
 * They are listed in the player's Subtitles menu as soon as they arrive, but
 * a file is only loaded into the player when it is picked (by the user, or by
 * the preferred subtitle languages): mpv downloads a file as it adds it, and
 * an addon can offer hundreds.
 */
import {
  parseSubtitlesResponse,
  supportsResource,
  type ResourceRequest,
  type Subtitle,
} from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import { languageCode, languageFromName, languageName } from '@/features/playback/track-labels';

/** A subtitle file an addon offers. */
export interface AddonSubtitle {
  /** An https URL. */
  url: string;
  /** A BCP 47-shaped tag for the player (`eng`, `pt-BR`); missing when unknown. */
  language?: string;
  /** The addon's own name for the file, if it gave one. */
  label?: string;
  /** Where it comes from: the addon's name. */
  origin: string;
}

/** What subtitle addons are told about the stream, to match its release. */
export interface StreamFile {
  filename?: string;
  /** Bytes. */
  videoSize?: number;
}

/** Subtitles kept from one addon (OpenSubtitles sends its best matches first). */
export const MAX_SUBTITLES_PER_ADDON = 200;
/** Subtitles kept for one stream, from every addon together. */
export const MAX_SUBTITLES = 600;
/** Subtitles kept from the stream itself. */
export const MAX_STREAM_SUBTITLES = 50;
const MAX_LABEL_LENGTH = 120;
const MAX_ORIGIN_LENGTH = 120;
const URL_LENGTH = 2048;

/** Installed addons that offer subtitles for `type`/`id`, in install order. */
export function subtitleAddons(addons: InstalledAddon[], type: string, id: string) {
  return addons.filter((addon) => supportsResource(addon.manifest, 'subtitles', type, id));
}

/**
 * The `subtitles` request for a movie or episode (`videoId`). The filename and
 * size let addons such as OpenSubtitles pick files timed for the release.
 */
export function subtitlesRequest(
  type: string,
  videoId: string,
  file?: StreamFile,
): ResourceRequest {
  const extra: Record<string, string> = {};
  const filename = file?.filename?.trim();
  if (filename) extra.filename = filename.slice(0, 256);
  if (file?.videoSize !== undefined && Number.isSafeInteger(file.videoSize) && file.videoSize > 0) {
    extra.videoSize = String(file.videoSize);
  }
  return {
    resource: 'subtitles',
    type,
    id: videoId,
    ...(Object.keys(extra).length > 0 && { extra }),
  };
}

/** Non-standard codes OpenSubtitles uses, as BCP 47 tags. */
const OPENSUBTITLES_CODES: Record<string, string> = {
  pob: 'pt-BR',
  pb: 'pt-BR',
  spn: 'es-ES',
  ea: 'es-419',
  zht: 'zh-Hant',
  zhe: 'zh',
  ze: 'zh',
};

/**
 * A language as the player accepts it (letters, digits and `-`, at most 35):
 * tags are kept (`pt_BR` becomes `pt-BR`), English names become codes
 * (`English` → `en`), and anything else, or `und`, is dropped.
 */
export function subtitleLanguage(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const tag = OPENSUBTITLES_CODES[trimmed.toLowerCase()] ?? trimmed.replaceAll('_', '-');
  if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(tag) && tag.length <= 35) {
    return languageCode(tag) ? tag : undefined;
  }
  return languageFromName(trimmed);
}

/** Printable text, trimmed and bounded; empty becomes undefined. */
function cleanText(value: string | undefined, max: number): string | undefined {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const text = value?.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

function isHttpsUrl(value: string): boolean {
  if (value.length > URL_LENGTH) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Addon subtitles (already validated by `@kiro/addon-sdk`) as the player lists them. */
export function toAddonSubtitles(
  subtitles: readonly Pick<Subtitle, 'url' | 'lang' | 'label'>[],
  origin: string,
  max = MAX_SUBTITLES_PER_ADDON,
): AddonSubtitle[] {
  const name = cleanText(origin, MAX_ORIGIN_LENGTH) ?? 'Addon';
  return subtitles
    .filter((subtitle) => isHttpsUrl(subtitle.url))
    .slice(0, max)
    .map((subtitle) => {
      const language = subtitleLanguage(subtitle.lang);
      const label = cleanText(subtitle.label, MAX_LABEL_LENGTH);
      return {
        url: subtitle.url,
        ...(language && { language }),
        ...(label && { label }),
        origin: name,
      };
    });
}

/** `current` followed by the subtitles of `incoming` it lacks (by URL), up to `max`. */
export function mergeSubtitles(
  current: readonly AddonSubtitle[],
  incoming: readonly AddonSubtitle[],
  max = MAX_SUBTITLES,
): AddonSubtitle[] {
  const seen = new Set(current.map((subtitle) => subtitle.url));
  const merged = [...current];
  for (const subtitle of incoming) {
    if (merged.length >= max) break;
    if (seen.has(subtitle.url)) continue;
    seen.add(subtitle.url);
    merged.push(subtitle);
  }
  return merged;
}

/**
 * Reads subtitles kept in router state (a stream's own, see
 * `PlaybackRequest.subtitles`). Anything that doesn't check out is skipped.
 */
export function parseAddonSubtitles(value: unknown): AddonSubtitle[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_STREAM_SUBTITLES).flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { url, language, label, origin } = item as Record<string, unknown>;
    if (typeof url !== 'string' || typeof origin !== 'string') return [];
    if (language !== undefined && typeof language !== 'string') return [];
    if (label !== undefined && typeof label !== 'string') return [];
    return toAddonSubtitles([{ url, lang: language ?? 'und', label }], origin);
  });
}

/** The track name given to the player: the file's label or language, and the addon. */
export function playerLabel(subtitle: AddonSubtitle): string {
  const language = languageName(subtitle.language) ?? subtitle.language?.toUpperCase();
  return [subtitle.label ?? language ?? 'Subtitles', subtitle.origin].join(' · ');
}

export interface SubtitleOption {
  subtitle: AddonSubtitle;
  /** e.g. the addon's label for the file, or `OpenSubtitles v3 2`. */
  title: string;
  /** Where it comes from, when the title doesn't say. */
  detail?: string;
}

export interface SubtitleGroup {
  /** Comparable language code (`en`), or undefined for unknown languages. */
  code: string | undefined;
  /** e.g. `English`, or `Other languages`. */
  name: string;
  /** Whether it is one of the preferred subtitle languages. */
  preferred: boolean;
  options: SubtitleOption[];
}

/**
 * Addon subtitles by language for the Subtitles menu: the preferred
 * languages first (in preference order), then the rest by name, and
 * unknown languages last. Within a language, the addons' order is kept;
 * unlabelled files from the same addon are numbered.
 */
export function groupSubtitles(
  subtitles: readonly AddonSubtitle[],
  preferredLanguages: readonly string[],
): SubtitleGroup[] {
  const byLanguage = new Map<string | undefined, AddonSubtitle[]>();
  for (const subtitle of subtitles) {
    const code = languageCode(subtitle.language);
    byLanguage.set(code, [...(byLanguage.get(code) ?? []), subtitle]);
  }
  const preferred = preferredLanguages.map(languageCode).filter(Boolean);
  const rank = (code: string | undefined) => {
    if (code === undefined) return Infinity;
    const index = preferred.indexOf(code);
    return index === -1 ? preferred.length : index;
  };

  return [...byLanguage]
    .map(([code, members]) => {
      const name =
        code === undefined ? 'Other languages' : (languageName(code) ?? code.toUpperCase());
      return {
        code,
        name,
        preferred: rank(code) < preferred.length,
        options: options(members, name),
      };
    })
    .sort((a, b) => rank(a.code) - rank(b.code) || a.name.localeCompare(b.name));
}

function options(subtitles: AddonSubtitle[], groupName: string): SubtitleOption[] {
  const unlabelled = new Map<string, number>();
  for (const subtitle of subtitles) {
    if (!subtitle.label)
      unlabelled.set(subtitle.origin, (unlabelled.get(subtitle.origin) ?? 0) + 1);
  }
  const counters = new Map<string, number>();
  return subtitles.map((subtitle) => {
    // A regional variant (`Brazilian Portuguese` among Portuguese) says so.
    const variant = languageName(subtitle.language);
    const region = variant && variant !== groupName ? variant : undefined;
    if (subtitle.label) {
      return {
        subtitle,
        title: subtitle.label,
        detail: [region, subtitle.origin].filter(Boolean).join(' · '),
      };
    }
    const count = (counters.get(subtitle.origin) ?? 0) + 1;
    counters.set(subtitle.origin, count);
    const numbered = (unlabelled.get(subtitle.origin) ?? 0) > 1;
    return {
      subtitle,
      title: numbered ? `${subtitle.origin} ${count}` : subtitle.origin,
      ...(region && { detail: region }),
    };
  });
}

/** Fetches a resource from an addon (`addonCommands.fetchResource`). */
export type FetchResource = (
  url: string,
  request: ResourceRequest,
  options: { signal: AbortSignal },
) => Promise<unknown>;

/**
 * Asks every addon in `addons` for subtitles at once and reports each one's
 * as it answers. Failures and invalid answers are skipped: subtitles are
 * optional. Resolves when every addon has answered; aborting `signal` cancels
 * the requests and stops reporting.
 */
export async function fetchAddonSubtitles({
  addons,
  request,
  fetch,
  signal,
  onSubtitles,
}: {
  addons: readonly InstalledAddon[];
  request: ResourceRequest;
  fetch: FetchResource;
  signal: AbortSignal;
  onSubtitles: (subtitles: AddonSubtitle[]) => void;
}): Promise<void> {
  await Promise.all(
    addons.map(async (addon) => {
      let raw: unknown;
      try {
        raw = await fetch(addon.transportUrl, request, { signal });
      } catch {
        return;
      }
      if (signal.aborted) return;
      const parsed = parseSubtitlesResponse(raw);
      if (!parsed.ok) return;
      const subtitles = toAddonSubtitles(parsed.value.subtitles, addon.manifest.name);
      if (subtitles.length > 0) onSubtitles(subtitles);
    }),
  );
}
