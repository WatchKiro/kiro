/**
 * Skip intro and Skip credits: finds the parts of a video worth skipping from
 * its chapter titles (`Intro`, `OP`, `Previously on…`, `End Credits`, `ED`,
 * `Preview`, and their equivalents in other languages).
 *
 * Chapter titles are whatever the release put there, so this is deliberately
 * conservative: a title has to name the part outright (`Opening Night` is not
 * an opening), and a part has to be where and as long as such parts are.
 * When unsure, nothing is offered. Parts looked up online for files without
 * such chapters (`online-skip.ts`) are held to the same rules.
 */
import type { Chapter } from '@kiro/player-core';
import { formatDuration } from '@kiro/utils';

/** What a chapter is, judging by its title. */
export type ChapterRole = 'intro' | 'recap' | 'credits' | 'preview';

/** What a skip button skips: one or more neighbouring chapters of the same kind. */
export interface SkipSegment {
  /** `intro` also covers a recap next to it; `credits` a preview after them. */
  kind: ChapterRole;
  /** Seconds. Skipping seeks to `end`. */
  start: number;
  end: number;
}

/** Parts shorter than this are not worth a button (or are mislabelled). */
const MIN_SEGMENT_SECONDS = 5;
/** Intros and recaps are at most this long, and at most this share of the video. */
const MAX_OPENING_SECONDS = 5 * 60;
const MAX_OPENING_SHARE = 0.25;
/** Credits (with a preview) are at most this long, and this share of the video. */
const MAX_CLOSING_SECONDS = 20 * 60;
const MAX_CLOSING_SHARE = 0.4;
/**
 * The button goes this long before the end of a part, so a seek that lands
 * just short of the end does not bring it back.
 */
const END_GUARD_SECONDS = 1;

/** Lower-cased, without accents, punctuation as single spaces. */
function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Titles that name each role, in common release languages. Matched against
 * the whole (normalised) title, optionally followed by a number (`OP2`,
 * `Ending 2`). A trailing ` *` also accepts anything after it
 * (`Previously on Breaking Bad`).
 */
// prettier-ignore
const TITLES: Record<ChapterRole | 'either', readonly string[]> = {
  intro: [
    // English
    'intro', 'intro song', 'intro credits', 'opening', 'opening credits', 'opening titles',
    'opening theme', 'opening song', 'opening sequence', 'op', 'title sequence', 'main titles',
    'main title', 'theme song',
    // German, French, Spanish, Italian, Portuguese, Dutch, Polish
    'vorspann', 'générique de début', "générique d'ouverture",
    'apertura', 'cabecera', 'créditos iniciales', 'sigla iniziale', 'sigla di apertura',
    "sigla d'apertura", 'titoli di testa', 'abertura', 'créditos iniciais', 'begintitels',
    'czołówka',
    // Russian, Japanese, Chinese, Korean
    'опенинг', 'заставка', 'начальные титры', 'オープニング', '片头', '片頭', '片头曲', '片頭曲',
    '오프닝', '인트로',
  ],
  recap: [
    'recap', 'previously', 'previously on *', 'last time on *', 'the story so far',
    'story so far', 'previous episode', 'in the previous episode',
    'rückblick', 'was bisher geschah', 'zuvor bei *', 'bisher bei *',
    'précédemment', 'précédemment dans *', "dans l'épisode précédent",
    'resumen', 'anteriormente', 'anteriormente en *', 'anteriormente em *',
    'en el episodio anterior', 'riassunto', 'nelle puntate precedenti',
    "nell'episodio precedente", 'precedentemente', 'precedentemente su *', 'resumo',
    'no episódio anterior', 'eerder', 'eerder in *', 'eerder bij *', 'poprzednio',
    'poprzednio w *', 'w poprzednim odcinku',
    'ранее', 'ранее в *', 'в предыдущих сериях', 'в предыдущей серии',
    '前回のあらすじ', 'あらすじ', '前情提要', '前情回顾', '前情回顧', '지난 이야기',
  ],
  credits: [
    'credits', 'end credits', 'ending credits', 'closing credits', 'end titles', 'end title',
    'closing titles', 'ending', 'ending theme', 'ending song', 'ending sequence', 'ed',
    'outro', 'outro song', 'credits roll',
    'abspann', 'nachspann', 'générique de fin', 'générique final', 'crédits', 'créditos',
    'créditos finales', 'títulos de crédito', 'titoli di coda', 'sigla finale',
    'sigla di chiusura', 'crediti', 'créditos finais', 'encerramento', 'aftiteling',
    'eindtitels', 'napisy końcowe',
    'титры', 'финальные титры', 'заключительные титры', 'эндинг', 'エンディング',
    'スタッフロール', '片尾', '片尾曲', '演职员表', '演職員表', '엔딩', '엔딩 크레딧', '크레딧',
  ],
  preview: [
    'preview', 'next episode preview', 'episode preview', 'next episode', 'next time',
    'next time on *', 'vorschau', 'nächste folge', 'aperçu', 'prochain épisode', 'avance',
    'adelanto', 'próximo episodio', 'próximo capítulo', 'anteprima', 'prossimo episodio',
    'prévia', 'próximo episódio', 'zapowiedź', 'превью', 'анонс', 'в следующей серии',
    '予告', '次回予告', '预告', '預告', '下集预告', '下集預告', '예고', '다음 이야기',
  ],
  /** The theme, which opens or closes depending on where it is. */
  either: ['générique', 'sigla', 'jenerik'],
};

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MATCHERS = Object.entries(TITLES).map(([role, titles]) => {
  const alternatives = titles.map((title) =>
    title.endsWith(' *')
      ? `${escape(normalize(title.slice(0, -2)))}(?: .+)?`
      : escape(normalize(title)),
  );
  return {
    role: role as ChapterRole | 'either',
    pattern: new RegExp(`^(?:${alternatives.join('|')})(?: ?\\d{1,2})?$`, 'u'),
  };
});

/** `Chapter 3 - `, `01. `: numbering before the name. */
const NUMBERING =
  /^\s*(?:(?:chapter|chapitre|kapitel|capítulo|capitulo|capitolo|hoofdstuk|rozdział|глава)\s*)?\d{1,3}\s*(?:[.:)\-–—]\s*|\s+)/iu;
/** `Opening: Song name`, `ED - Song name`: what follows is the song, not the role. */
const SEPARATOR = /\s+[-–—]\s+|\s*[:|：–—]\s*/u;

/**
 * The role a chapter title names, or `undefined` when it names none (or is
 * unclear). `either` means the theme song, placed by {@link skipSegments}.
 */
export function classifyChapterTitle(
  title: string | undefined,
): ChapterRole | 'either' | undefined {
  if (!title) return undefined;
  const unnumbered = title.replace(NUMBERING, '');
  const candidates = new Set([
    normalize(unnumbered),
    normalize(unnumbered.split(SEPARATOR)[0] ?? ''),
  ]);
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const { role, pattern } of MATCHERS) {
      if (pattern.test(candidate)) return role;
    }
  }
  return undefined;
}

const OPENING: readonly ChapterRole[] = ['intro', 'recap'];

/**
 * The parts of a video that can be skipped, in order. Neighbouring chapters
 * on the same side (a recap then the intro, or the credits then a preview)
 * are skipped together. Parts that are too short, too long or in the wrong
 * half of the video for what their title says are left out.
 */
export function skipSegments(chapters: readonly Chapter[], duration: number | null): SkipSegment[] {
  // Without the duration, neither the last chapter's end nor the halves are known.
  if (duration === null || !(duration > 0) || chapters.length < 2) return [];

  const parts: SkipSegment[] = [];
  chapters.forEach((chapter, index) => {
    const start = chapter.start;
    const end = Math.min(chapters[index + 1]?.start ?? duration, duration);
    if (!(end > start)) return;
    const named = classifyChapterTitle(chapter.title);
    const kind = named === 'either' ? (start < duration / 2 ? 'intro' : 'credits') : named;
    if (!kind) return;
    const previous = parts.at(-1);
    if (
      previous &&
      previous.end === start &&
      OPENING.includes(previous.kind) === OPENING.includes(kind)
    ) {
      previous.end = end;
      // An intro next to a recap is called an intro; credits beside a preview, credits.
      if (kind === 'intro' || kind === 'credits') previous.kind = kind;
    } else {
      parts.push({ kind, start, end });
    }
  });

  return parts.filter((part) => isPlausible(part, duration));
}

/**
 * Whether a part is where and as long as such parts are: intros and recaps
 * in the first half and at most 5 minutes (and a quarter of the video),
 * credits in the second half and at most 20 minutes (and 40 %), none under
 * 5 s. Applies to parts from chapters and from online lookups alike.
 */
export function isPlausible({ kind, start, end }: SkipSegment, duration: number): boolean {
  const length = end - start;
  if (!(length >= MIN_SEGMENT_SECONDS) || start < 0 || end > duration) return false;
  return OPENING.includes(kind)
    ? start < duration / 2 && length <= Math.min(MAX_OPENING_SECONDS, duration * MAX_OPENING_SHARE)
    : start >= duration / 2 &&
        length <= Math.min(MAX_CLOSING_SECONDS, duration * MAX_CLOSING_SHARE);
}

/**
 * Parts from somewhere other than the file (an online lookup), made to
 * follow the same rules as chapters: in order, overlapping or touching parts
 * on the same side joined (a recap running into the intro), and anything
 * implausible left out.
 */
export function externalSkipSegments(
  parts: readonly SkipSegment[],
  duration: number | null,
): SkipSegment[] {
  if (duration === null || !(duration > 0)) return [];
  const joined: SkipSegment[] = [];
  for (const { kind, start, end } of [...parts].sort((a, b) => a.start - b.start)) {
    const previous = joined.at(-1);
    if (
      previous &&
      start <= previous.end &&
      OPENING.includes(previous.kind) === OPENING.includes(kind)
    ) {
      previous.end = Math.max(previous.end, end);
      if (kind === 'intro' || kind === 'credits') previous.kind = kind;
    } else {
      joined.push({ kind, start, end });
    }
  }
  return joined.filter((part) => isPlausible(part, duration));
}

/** The part playback is in, if any (not in its last second, see `END_GUARD_SECONDS`). */
export function segmentAt(
  segments: readonly SkipSegment[],
  position: number,
): SkipSegment | undefined {
  return segments.find(
    (segment) => position >= segment.start && position < segment.end - END_GUARD_SECONDS,
  );
}

/**
 * Where the closing credits start, when they run to the end of the video:
 * from there on, the rest is credits, so Up next can be offered. `null` when
 * something (a post-credits scene) follows them.
 */
export function creditsStart(
  segments: readonly SkipSegment[],
  duration: number | null,
): number | null {
  const last = segments.at(-1);
  return last &&
    !OPENING.includes(last.kind) &&
    duration !== null &&
    last.end >= duration - END_GUARD_SECONDS
    ? last.start
    : null;
}

/** The button's text. */
export function skipLabel(kind: ChapterRole): string {
  return {
    intro: 'Skip intro',
    recap: 'Skip recap',
    credits: 'Skip credits',
    preview: 'Skip preview',
  }[kind];
}

/** Intros and recaps can be skipped automatically (a setting); credits never are. */
export function isAutoSkippable(kind: ChapterRole): boolean {
  return OPENING.includes(kind);
}

/**
 * An online lookup for a file whose chapters mark nothing (`online-skip.ts`),
 * as far as the stats overlay is concerned. `source` names the service.
 */
export type OnlineLookup =
  | { state: 'looking'; source: string }
  | {
      state: 'found';
      source: string;
      /** The recorded file's length was this many seconds off (parts trimmed for it). */
      offset?: number;
    }
  | {
      state: 'none';
      source: string;
      /** It has times for the episode, but none usable for this file. */
      otherReleases: boolean;
      /** How long the files those times were recorded on are, where known. */
      otherLengths?: readonly number[];
      /** This file's length, to compare. */
      fileLength?: number | null;
    }
  | { state: 'failed'; source: string };

function describeParts(segments: readonly SkipSegment[]): string {
  return segments
    .map(({ kind, start, end }) => `${kind} ${formatDuration(start)}–${formatDuration(end)}`)
    .join(', ');
}

/**
 * What the file offers, for the stats overlay: `4 chapters · intro 0:00–0:50,
 * credits 3:20–4:00`. Says so when there are no chapters, or none named as an
 * intro or credits, which is why Skip intro would never show. With a lookup,
 * says what it found and where: `no chapters · intro 1:13–1:30 (SkipDB)`.
 */
export function describeChapters(
  chapterCount: number,
  segments: readonly SkipSegment[],
  online?: OnlineLookup,
): string {
  const count = `${chapterCount} chapter${chapterCount === 1 ? '' : 's'}`;
  if (online) {
    const chapters = chapterCount === 0 ? 'no chapters' : count;
    const { source } = online;
    switch (online.state) {
      case 'looking':
        return `${chapters} · looking up on ${source}`;
      case 'found': {
        // e.g. `(SkipDB, 10 s longer cut)`: recorded on another release, trimmed.
        const offset = Math.round(online.offset ?? 0);
        const cut =
          offset === 0 ? '' : `, ${Math.abs(offset)} s ${offset > 0 ? 'longer' : 'shorter'} cut`;
        return `${chapters} · ${describeParts(segments)} (${source}${cut})`;
      }
      case 'none': {
        const lengths = online.otherLengths ?? [];
        if (lengths.length > 0 && online.fileLength) {
          // e.g. `SkipDB has a 22:48 cut (this file 22:13)`: why nothing matched.
          const cuts = lengths.map((length) => formatDuration(length)).join(', ');
          const article = lengths.length === 1 ? 'a ' : '';
          const noun = lengths.length === 1 ? 'cut' : 'cuts';
          return `${chapters} · ${source} has ${article}${cuts} ${noun} (this file ${formatDuration(online.fileLength)})`;
        }
        return online.otherReleases
          ? `${chapters} · ${source} has other releases only`
          : `${chapters} · nothing on ${source}`;
      }
      case 'failed':
        return `${chapters} · ${source} unavailable`;
    }
  }
  if (chapterCount === 0) return 'none in this file';
  if (segments.length === 0) return `${count} · no intro or credits named`;
  return `${count} · ${describeParts(segments)}`;
}
