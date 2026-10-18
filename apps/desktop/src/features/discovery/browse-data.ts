import {
  supportsResource,
  type ManifestCatalog,
  type MetaPreview,
  type ResourceExtra,
} from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import { catalogKey } from '@/features/addons/catalog';

/** A browse page and the addon content type it lists. */
export interface BrowseSection {
  /** Content type requested from addons (`movie`, `series`). */
  type: string;
  title: string;
  /** Plural noun for messages, e.g. "No addon provides movies". */
  noun: string;
  /** The page's route. */
  path: string;
  /**
   * Where its row layout is saved (`settings.rows`). Pages for other types
   * (an anime addon's) show every catalogue in addon order instead.
   */
  page?: 'movies' | 'tvShows';
}

export const MOVIES: BrowseSection = {
  type: 'movie',
  title: 'Movies',
  noun: 'movies',
  path: '/movies',
  page: 'movies',
};
export const TV_SHOWS: BrowseSection = {
  type: 'series',
  title: 'TV Shows',
  noun: 'TV shows',
  path: '/tv',
  page: 'tvShows',
};
const SECTIONS = [MOVIES, TV_SHOWS];

/** Names for content types addons commonly use beyond movies and series. */
const TYPE_TITLES: Record<string, string> = { tv: 'Live TV', channel: 'Channels' };

/**
 * The browse page for a content type: Movies and TV Shows, or a page of its
 * own for any other type an addon lists (Anime Kitsu's `anime`).
 */
export function sectionFor(type: string): BrowseSection {
  const known = SECTIONS.find((section) => section.type === type);
  if (known) return known;
  const title =
    TYPE_TITLES[type] ??
    type
      .replace(/[-_]+/g, ' ')
      .trim()
      .replace(/(^|\s)\p{L}/gu, (start) => start.toUpperCase());
  return {
    type,
    title: title || 'Other',
    noun: (title || 'other').toLowerCase(),
    path: `/browse/${encodeURIComponent(type)}`,
  };
}

/**
 * Content types other than movies and series that installed addons list
 * catalogues of, in the order they first appear. Each gets a browse page.
 */
export function otherTypes(addons: InstalledAddon[]): string[] {
  const types = discoverSources(addons).map(({ catalog }) => catalog.type);
  return [...new Set(types)].filter((type) => !SECTIONS.some((section) => section.type === type));
}

/** One browsable catalogue of an installed addon. */
export interface BrowseSource {
  addon: InstalledAddon;
  catalog: ManifestCatalog;
}

/** A catalogue's genre filter: its options and whether one must be chosen. */
export interface GenreFilter {
  options: string[];
  required: boolean;
}

/** The most items a feed keeps; it stops paging after this. */
export const MAX_FEED_ITEMS = 1000;

/**
 * The catalogue's `genre` extra, when it lists options. A catalogue that
 * requires a genre (Cinemeta's "New" requires a year) has no "All" choice.
 */
export function genreFilter(catalog: ManifestCatalog): GenreFilter | null {
  const extra = catalog.extra?.find((candidate) => candidate.name === 'genre');
  if (!extra?.options?.length) return null;
  return { options: extra.options, required: extra.isRequired ?? false };
}

/** What a filter's options are: Cinemeta's "New" catalogues filter by year. */
export function filterLabel({ options }: GenreFilter): 'Genre' | 'Year' {
  return options.every((option) => /^\d{4}$/.test(option)) ? 'Year' : 'Genre';
}

/**
 * Whether Kiro can list the catalogue without user input: every extra it
 * requires is a `genre` with options, so a default can be picked.
 */
export function isBrowsableCatalog(catalog: ManifestCatalog): boolean {
  return (catalog.extra ?? []).every(
    (extra) => !extra.isRequired || (extra.name === 'genre' && Boolean(extra.options?.length)),
  );
}

/**
 * Every browsable catalogue, in addon install order then manifest order.
 * Catalogues the addon's `catalog` resource does not cover are left out.
 */
export function discoverSources(addons: InstalledAddon[]): BrowseSource[] {
  return addons.flatMap((addon) =>
    addon.manifest.catalogs
      .filter(
        (catalog) =>
          isBrowsableCatalog(catalog) && supportsResource(addon.manifest, 'catalog', catalog.type),
      )
      .map((catalog) => ({ addon, catalog })),
  );
}

/** Every browsable catalogue of `type` (see {@link discoverSources}). */
export function browseSources(addons: InstalledAddon[], type: string): BrowseSource[] {
  return discoverSources(addons).filter(({ catalog }) => catalog.type === type);
}

/** The browse page showing a source in full. */
export function browsePath(source: BrowseSource): string {
  const { path } = sectionFor(source.catalog.type);
  return `${path}?${new URLSearchParams({ catalog: sourceParam(source) }).toString()}`;
}

/**
 * A row heading on Discover, where types mix: "Popular movies", "New TV
 * shows". Other types (an anime addon's "Top Airing") keep their own name.
 */
export function rowTitle({ catalog }: BrowseSource): string {
  const section = SECTIONS.find(({ type }) => type === catalog.type);
  return section ? `${catalogName(catalog)} ${section.noun}` : catalogName(catalog);
}

/**
 * The genre to request: `requested` when the catalogue offers it, otherwise
 * the first option of a catalogue that requires one, otherwise none.
 */
export function effectiveGenre(catalog: ManifestCatalog, requested?: string): string | undefined {
  const filter = genreFilter(catalog);
  if (!filter) return undefined;
  if (requested && filter.options.includes(requested)) return requested;
  return filter.required ? filter.options[0] : undefined;
}

/** Catalogue extras for one page: the genre, if any, and `skip` past the first page. */
export function catalogExtra(genre: string | undefined, skip: number): ResourceExtra | undefined {
  const extra: Record<string, string> = {};
  if (genre) extra.genre = genre;
  if (skip > 0) extra.skip = String(skip);
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** Key of a source's feed (for one genre) in the browse store. */
export function feedKey({ addon, catalog }: BrowseSource, genre: string | undefined): string {
  return JSON.stringify([catalogKey(addon.transportUrl, catalog), genre ?? null]);
}

/**
 * The `?catalog=` value naming a source. Addon ids are stable across
 * reinstalls, unlike positions in the installed list.
 */
export function sourceParam({ addon, catalog }: BrowseSource): string {
  return `${addon.manifest.id}/${catalog.id}`;
}

/** The source a `?catalog=` value names, if it is still installed. */
export function findSource(
  sources: BrowseSource[],
  param: string | null,
): BrowseSource | undefined {
  return param ? sources.find((source) => sourceParam(source) === param) : undefined;
}

/**
 * Display name of a source. The addon's name is added when another source
 * shares the catalogue name, e.g. two addons that both have "Popular".
 */
export function sourceLabel(source: BrowseSource, sources: BrowseSource[]): string {
  const name = catalogName(source.catalog);
  const ambiguous = sources.some(
    (other) => other !== source && catalogName(other.catalog) === name,
  );
  return ambiguous ? `${name} · ${source.addon.manifest.name}` : name;
}

function catalogName(catalog: ManifestCatalog): string {
  return catalog.name ?? catalog.id;
}

/**
 * Appends a page to a feed, dropping items it already has: addons that page
 * by a fixed size may overlap when an earlier page was short.
 */
export function appendPage(items: MetaPreview[], page: MetaPreview[]): MetaPreview[] {
  const seen = new Set(items.map((item) => `${item.type}:${item.id}`));
  const added: MetaPreview[] = [];
  for (const item of page) {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(item);
  }
  return added.length > 0 ? [...items, ...added] : items;
}
