/**
 * Picks the audio and subtitle tracks that match the user's preferred
 * languages (Settings → Playback) when a stream loads.
 */
import type { MediaTrack } from '@kiro/player-core';

import type { AddonSubtitle } from '@/features/playback/addon-subtitles';
import { languageCode } from '@/features/playback/track-labels';
import type { PlaybackSettings, SubtitleSettings } from '@/services/native';

/** What track choice reads from the settings (Settings → Playback and Subtitles). */
export type TrackSettings = Pick<
  PlaybackSettings,
  'audioLanguages' | 'subtitleLanguages' | 'subtitlesOff'
> & {
  /** Which subtitles to pick within a language. Default: `regular`. */
  preferredSubtitleType?: SubtitleSettings['preferredType'];
};

/** The tracks to switch to. `undefined` keeps the stream's own choice. */
export interface TrackChoice {
  audioTrackId?: string;
  /** `null` turns subtitles off. */
  subtitleTrackId?: string | null;
  /** An addon subtitle to load and show, when it beats the stream's own tracks. */
  addonSubtitle?: AddonSubtitle;
}

const COMMENTARY = /commentary|director|description|\bAD\b/i;
const HEARING_IMPAIRED = /\b(SDH|CC|HI)\b|hearing/i;
const FORCED = /\bforced\b/i;

/** Lower sorts first: what to prefer among tracks in the same language. */
function audioRank(track: MediaTrack): number {
  return (COMMENTARY.test(track.label ?? '') ? 2 : 0) + (track.isDefault ? 0 : 1);
}

type SubtitleType = NonNullable<TrackSettings['preferredSubtitleType']>;

/**
 * Lower sorts first. Each preference puts its own type first; `regular` puts
 * full subtitles before SDH, and forced ones (signs only) last.
 */
const TYPE_RANKS: Record<SubtitleType, Record<SubtitleType, number>> = {
  regular: { regular: 0, sdh: 1, forced: 2 },
  sdh: { sdh: 0, regular: 1, forced: 2 },
  forced: { forced: 0, regular: 1, sdh: 2 },
};

function subtitleType(forced: boolean | undefined, label: string | undefined): SubtitleType {
  if (forced || FORCED.test(label ?? '')) return 'forced';
  return HEARING_IMPAIRED.test(label ?? '') ? 'sdh' : 'regular';
}

function subtitleRank(preferred: SubtitleType) {
  return (track: MediaTrack) =>
    TYPE_RANKS[preferred][subtitleType(track.isForced, track.label)] * 2 +
    (track.isDefault ? 0 : 1);
}

function addonSubtitleRank(preferred: SubtitleType) {
  return (subtitle: AddonSubtitle) => TYPE_RANKS[preferred][subtitleType(false, subtitle.label)];
}

/**
 * The best track in the first preferred language that has one. Ties keep the
 * stream's order (`toSorted` is stable).
 */
function bestMatch<T extends { language?: string }>(
  tracks: readonly T[],
  languages: readonly string[],
  rank: (track: T) => number,
): T | undefined {
  for (const language of languages) {
    const wanted = languageCode(language);
    const matches = tracks.filter((track) => wanted && languageCode(track.language) === wanted);
    if (matches.length > 0) return matches.toSorted((a, b) => rank(a) - rank(b))[0];
  }
  return undefined;
}

/**
 * Chooses tracks for `settings`:
 * - audio: the first preferred language the stream has (its default track,
 *   and not a commentary, when there are several);
 * - subtitles off: none, except forced subtitles in the chosen audio's
 *   language (they translate signs and foreign dialogue);
 * - otherwise: the first preferred subtitle language that the stream or an
 *   addon has: full subtitles before SDH, then forced ones, unless SDH or
 *   forced subtitles are preferred (Settings → Subtitles). The stream's own
 *   track wins within a language: it needs no download and is timed for it.
 *
 * Anything without a match keeps the stream's default. Only returns changes
 * from the current selection.
 */
export function chooseTracks(
  tracks: readonly MediaTrack[],
  settings: TrackSettings,
  current: { audioTrackId: string | null; subtitleTrackId: string | null },
  addonSubtitles: readonly AddonSubtitle[] = [],
): TrackChoice {
  const audio = tracks.filter((track) => track.kind === 'audio');
  const subtitles = tracks.filter((track) => track.kind === 'subtitle');
  const preferred = settings.preferredSubtitleType ?? 'regular';
  const choice: TrackChoice = {};

  const audioTrack = bestMatch(audio, settings.audioLanguages, audioRank);
  if (audioTrack && audioTrack.id !== current.audioTrackId) choice.audioTrackId = audioTrack.id;
  const audioLanguage = languageCode(
    (audioTrack ?? audio.find((track) => track.id === current.audioTrackId))?.language,
  );

  let subtitleId: string | null | undefined;
  if (settings.subtitlesOff) {
    const forced = subtitles.find(
      (track) => track.isForced && audioLanguage && languageCode(track.language) === audioLanguage,
    );
    subtitleId = forced?.id ?? null;
  } else {
    for (const language of settings.subtitleLanguages) {
      const track = bestMatch(subtitles, [language], subtitleRank(preferred));
      if (track) {
        subtitleId = track.id;
        break;
      }
      const addonSubtitle = bestMatch(addonSubtitles, [language], addonSubtitleRank(preferred));
      if (addonSubtitle) {
        choice.addonSubtitle = addonSubtitle;
        break;
      }
    }
  }
  if (subtitleId !== undefined && subtitleId !== current.subtitleTrackId) {
    choice.subtitleTrackId = subtitleId;
  }
  return choice;
}
