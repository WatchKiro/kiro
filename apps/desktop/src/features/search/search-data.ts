import { searchableCatalogs, type ManifestCatalog, type MetaPreview } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import { catalogKey } from '@/features/addons/catalog';

/** Longest query sent to addons; the input enforces it too. */
export const MAX_QUERY_LENGTH = 200;
/** Typing searches once the query is this long; Enter searches any query. */
export const MIN_LIVE_QUERY_LENGTH = 2;
/** Pause in typing before a live search starts. */
export const SEARCH_DEBOUNCE_MS = 300;

/** One searchable catalogue of an installed addon. */
export interface SearchTarget {
  addon: InstalledAddon;
  catalog: ManifestCatalog;
}

/** Every searchable catalogue, in addon install order then manifest order. */
export function searchTargets(addons: InstalledAddon[]): SearchTarget[] {
  return addons.flatMap((addon) =>
    searchableCatalogs(addon.manifest).map((catalog) => ({ addon, catalog })),
  );
}

/** Key of a target's results in the search store. */
export function searchKey({ addon, catalog }: SearchTarget): string {
  return catalogKey(addon.transportUrl, catalog);
}

/** Trims, collapses whitespace and caps the length of a query. */
export function normalizeQuery(input: string): string {
  return input.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LENGTH).trimEnd();
}

/** The search page for a query (`/search` alone for an empty one). */
export function searchPath(query: string): string {
  const normalized = normalizeQuery(query);
  return normalized ? `/search?${new URLSearchParams({ q: normalized }).toString()}` : '/search';
}

/** Targets grouped by content type, in order of first appearance. */
export function groupByType(targets: SearchTarget[]): { type: string; targets: SearchTarget[] }[] {
  const groups = new Map<string, SearchTarget[]>();
  for (const target of targets) {
    const group = groups.get(target.catalog.type);
    if (group) group.push(target);
    else groups.set(target.catalog.type, [target]);
  }
  return [...groups].map(([type, grouped]) => ({ type, targets: grouped }));
}

const TYPE_LABELS: Record<string, string> = {
  movie: 'Movies',
  series: 'TV Shows',
  channel: 'Channels',
  tv: 'TV Channels',
};

/** Heading for a content type's results. */
export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

/** Drops repeated items (same type and id), which would collide as React keys. */
export function uniqueItems(items: MetaPreview[]): MetaPreview[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
