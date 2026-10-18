import type { MediaTrack } from '@kiro/player-core';

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/** English name for an ISO 639 / BCP 47 code (`eng`, `ger`, `pt-BR`), if known. */
export function languageName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  try {
    const name = languageNames.of(code);
    return name && name !== code && name !== 'root' ? name : undefined;
  } catch {
    // Not a well-formed tag.
    return undefined;
  }
}

/**
 * ISO 639-2 codes (bibliographic and terminology forms, as Matroska files use
 * them) for languages that also have a two-letter ISO 639-1 code, plus
 * retired and macrolanguage aliases. Not exhaustive: other three-letter codes
 * are kept as they are and still match themselves.
 */
// prettier-ignore
const ISO_639_1: Record<string, string> = {
  ara: 'ar', bul: 'bg', ben: 'bn', cat: 'ca', cze: 'cs', ces: 'cs', wel: 'cy', cym: 'cy',
  dan: 'da', ger: 'de', deu: 'de', gre: 'el', ell: 'el', eng: 'en', spa: 'es', est: 'et',
  baq: 'eu', eus: 'eu', per: 'fa', fas: 'fa', fin: 'fi', fre: 'fr', fra: 'fr', gle: 'ga',
  glg: 'gl', heb: 'he', iw: 'he', hin: 'hi', hrv: 'hr', scr: 'hr', hun: 'hu', arm: 'hy',
  hye: 'hy', ind: 'id', in: 'id', ice: 'is', isl: 'is', ita: 'it', jpn: 'ja', geo: 'ka',
  kat: 'ka', kaz: 'kk', khm: 'km', kan: 'kn', kor: 'ko', lit: 'lt', lav: 'lv', mac: 'mk',
  mkd: 'mk', mal: 'ml', mar: 'mr', may: 'ms', msa: 'ms', bur: 'my', mya: 'my', nep: 'ne',
  dut: 'nl', nld: 'nl', nor: 'no', nob: 'no', nb: 'no', nno: 'no', nn: 'no', pan: 'pa',
  pol: 'pl', por: 'pt', rum: 'ro', ron: 'ro', mol: 'ro', rus: 'ru', sin: 'si', slo: 'sk',
  slk: 'sk', slv: 'sl', alb: 'sq', sqi: 'sq', srp: 'sr', scc: 'sr', swe: 'sv', swa: 'sw',
  tam: 'ta', tel: 'te', tha: 'th', tgl: 'tl', tur: 'tr', ukr: 'uk', urd: 'ur', uzb: 'uz',
  vie: 'vi', chi: 'zh', zho: 'zh', cmn: 'zh', zul: 'zu',
};

/** Codes that name no particular language (undetermined, none, multiple). */
const NO_LANGUAGE = new Set(['und', 'mis', 'mul', 'zxx', 'qaa']);

/**
 * A track or preference language reduced to one comparable code: the base
 * language of a BCP 47 tag (`pt-BR` → `pt`), with ISO 639-2 codes mapped to
 * their two-letter form (`ger`, `deu` → `de`). Undefined when there is no
 * usable language.
 */
export function languageCode(code: string | undefined): string | undefined {
  const base = code?.trim().toLowerCase().split(/[-_]/)[0];
  if (!base || !/^[a-z]{2,3}$/.test(base) || NO_LANGUAGE.has(base)) return undefined;
  return ISO_639_1[base] ?? base;
}

let namedLanguages: Map<string, string> | undefined;

/**
 * The code for an English language name (`English` → `en`), for addons that
 * send names instead of codes. Only languages with a two-letter code are
 * known.
 */
export function languageFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  namedLanguages ??= new Map(
    [...new Set(Object.values(ISO_639_1))].flatMap((code) => {
      const english = languageName(code);
      return english ? [[english.toLowerCase(), code] as const] : [];
    }),
  );
  return namedLanguages.get(name.trim().toLowerCase());
}

const CODEC_NAMES: Record<string, string> = {
  subrip: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  webvtt: 'WebVTT',
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  mov_text: 'Text',
  eac3: 'E-AC-3',
  truehd: 'TrueHD',
  'dts-hd': 'DTS-HD',
};

function codecName(codec: string): string {
  return CODEC_NAMES[codec] ?? codec.toUpperCase();
}

function channelLayout(channels: number): string {
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels} ch`;
}

/** A track's menu title (its name or language) and a line of details. */
export function describeTrack(track: MediaTrack): { title: string; detail: string } {
  const language = languageName(track.language) ?? track.language?.toUpperCase();
  const title = track.label ?? language ?? `Track ${track.id}`;
  const detail = [
    track.label && language && track.label !== language ? language : undefined,
    track.codec ? codecName(track.codec) : undefined,
    track.channels ? channelLayout(track.channels) : undefined,
    track.isForced ? 'Forced' : undefined,
    track.isExternal ? 'External' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return { title, detail };
}
