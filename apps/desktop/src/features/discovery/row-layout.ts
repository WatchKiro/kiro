/**
 * Which catalogue rows a page shows, and in what order: the installed
 * catalogues (see `discoverSources`) arranged by the layout saved in
 * Settings (`settings.rows`).
 *
 * A layout names rows by addon id, content type and catalogue id, which
 * survive addon updates and reinstalls. It keeps rows of addons that are
 * uninstalled or turned off, so they come back in their place, and ignores
 * rows nothing provides. Rows it doesn't know yet (a catalogue added by an
 * update, a newly installed addon) join it shown: after their addon's other
 * rows, or at the end for a new addon, flagged as new until the layout is
 * saved again.
 */
import type { BrowseSource } from '@/features/discovery/browse-data';
import { MAX_LAYOUT_ROWS } from '@/features/settings/settings-data';
import type { CatalogRowSetting, RowSettings } from '@/services/native';

/** A page that shows catalogue rows, as named in `settings.rows`. */
export type RowPage = keyof RowSettings;

/** One catalogue on a page. */
export interface LaidOutRow {
  /** {@link rowKey} of the catalogue. */
  key: string;
  source: BrowseSource;
  /** The catalogue's place in the default order (addon, then manifest order). */
  order: number;
  hidden: boolean;
  /** Not in the saved layout yet: its addon (or this catalogue) is new. */
  isNew: boolean;
}

export interface ResolvedLayout {
  /** Every available catalogue, in page order, hidden ones included. */
  rows: LaidOutRow[];
  /**
   * The layout to save from here: the saved one with new rows joined, and
   * remembered rows of missing addons kept in place.
   */
  entries: CatalogRowSetting[];
  /** Whether a layout is saved (otherwise this is the default). */
  customised: boolean;
}

/** A row's name in a layout. */
export function entryOf({ addon, catalog }: BrowseSource, hidden = false): CatalogRowSetting {
  return { addon: addon.manifest.id, type: catalog.type, catalog: catalog.id, hidden };
}

/** Identifies a catalogue across addon updates: addon id, type and catalogue id. */
export function rowKey(row: Pick<CatalogRowSetting, 'addon' | 'type' | 'catalog'>): string {
  return JSON.stringify([row.addon, row.type, row.catalog]);
}

export function sourceKey(source: BrowseSource): string {
  return rowKey(entryOf(source));
}

/**
 * Arranges `sources` (in default order) by a saved layout, or keeps the
 * default order, everything shown, when nothing is saved. Two installed
 * addons with the same id share their rows' places.
 */
export function resolveLayout(
  sources: BrowseSource[],
  saved: CatalogRowSetting[] | null,
): ResolvedLayout {
  const byKey = new Map<string, { source: BrowseSource; order: number }[]>();
  sources.forEach((source, order) => {
    const key = sourceKey(source);
    byKey.set(key, [...(byKey.get(key) ?? []), { source, order }]);
  });

  if (saved === null) {
    return {
      rows: sources.map((source, order) => ({
        key: sourceKey(source),
        source,
        order,
        hidden: false,
        isNew: false,
      })),
      entries: [...byKey.values()].flatMap(([first]) => (first ? [entryOf(first.source)] : [])),
      customised: false,
    };
  }

  const entries: CatalogRowSetting[] = [];
  const known = new Set<string>();
  for (const entry of saved) {
    const key = rowKey(entry);
    if (known.has(key)) continue;
    known.add(key);
    entries.push(entry);
  }

  const added = new Set<string>();
  for (const [key, [first]] of byKey) {
    if (known.has(key) || !first) continue;
    const entry = entryOf(first.source);
    // After the addon's last row, so an update's new catalogue sits with
    // its siblings; a new addon's rows go to the end, in manifest order.
    const last = entries.findLastIndex((other) => other.addon === entry.addon);
    entries.splice(last < 0 ? entries.length : last + 1, 0, entry);
    added.add(key);
  }

  return {
    rows: entries.flatMap((entry) => {
      const key = rowKey(entry);
      return (byKey.get(key) ?? []).map(({ source, order }) => ({
        key,
        source,
        order,
        hidden: entry.hidden,
        isNew: added.has(key),
      }));
    }),
    entries,
    customised: true,
  };
}

/** `entries` with a row shown or hidden. */
export function setHidden(
  entries: CatalogRowSetting[],
  key: string,
  hidden: boolean,
): CatalogRowSetting[] {
  return entries.map((entry) => (rowKey(entry) === key ? { ...entry, hidden } : entry));
}

/**
 * Moves a shown row to position `to` among the shown rows (`shown`, the
 * keys in page order). Hidden and remembered rows keep their places.
 */
export function moveRow(
  entries: CatalogRowSetting[],
  shown: string[],
  key: string,
  to: number,
): CatalogRowSetting[] {
  const from = entries.findIndex((entry) => rowKey(entry) === key);
  const others = shown.filter((other) => other !== key);
  const moving = entries[from];
  if (!moving || others.length === 0 || shown.indexOf(key) === to) return entries;

  const rest = entries.filter((_, index) => index !== from);
  const index = (target: string) => rest.findIndex((entry) => rowKey(entry) === target);
  const at =
    to < others.length
      ? index(others[Math.max(0, to)] as string)
      : index(others.at(-1) as string) + 1;
  if (at < 0) return entries;
  return [...rest.slice(0, at), moving, ...rest.slice(at)];
}

/**
 * A layout ready to save: at most {@link MAX_LAYOUT_ROWS} rows, forgetting
 * remembered rows (those `available` doesn't have) first, oldest last in
 * the list first.
 */
export function capLayout(
  entries: CatalogRowSetting[],
  available: ReadonlySet<string>,
): CatalogRowSetting[] {
  let excess = entries.length - MAX_LAYOUT_ROWS;
  if (excess <= 0) return entries;
  const kept = [...entries];
  for (let index = kept.length - 1; index >= 0 && excess > 0; index -= 1) {
    if (!available.has(rowKey(kept[index] as CatalogRowSetting))) {
      kept.splice(index, 1);
      excess -= 1;
    }
  }
  return kept.slice(0, MAX_LAYOUT_ROWS);
}

/** Names of the addons whose rows are new to the layout, in page order. */
export function newRowAddons(rows: LaidOutRow[]): string[] {
  return [...new Set(rows.filter((row) => row.isNew).map((row) => row.source.addon.manifest.name))];
}
