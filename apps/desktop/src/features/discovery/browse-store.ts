import { parseCatalogResponse, type MetaPreview } from '@kiro/addon-sdk';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { addonsStore } from '@/features/addons/addons-store';
import {
  appendPage,
  catalogExtra,
  feedKey,
  MAX_FEED_ITEMS,
  type BrowseSource,
} from '@/features/discovery/browse-data';
import { addonCommands, describeError } from '@/services/native';

/** The pages of one catalogue (for one genre) fetched so far. */
export interface Feed {
  items: MetaPreview[];
  /** Items the addon has sent so far, valid or not: the `skip` of the next page. */
  next: number;
  /** Whether another page may have more items. */
  hasMore: boolean;
  /** `loading` and `error` refer to the latest page; earlier items are kept. */
  status: 'loading' | 'ready' | 'error';
  error: string | null;
}

/** The native commands the store depends on; a fake is injected in tests. */
export type BrowseBackend = Pick<typeof addonCommands, 'fetchResource'>;

export interface BrowseState {
  /** Feeds by {@link feedKey}, kept across navigation. */
  feeds: Record<string, Feed>;

  /** Fetches the first page unless the feed is loading or already fetched. */
  load: (source: BrowseSource, genre: string | undefined) => Promise<void>;
  /** Fetches the next page of a fetched feed that has more. */
  loadMore: (source: BrowseSource, genre: string | undefined) => Promise<void>;
  /** Fetches the page that failed again. */
  retry: (source: BrowseSource, genre: string | undefined) => Promise<void>;
  /** Drops the feeds of these addons, e.g. after an update or uninstall. */
  forget: (transportUrls: string[]) => void;
}

const EMPTY: Feed = { items: [], next: 0, hasMore: true, status: 'ready', error: null };

export function createBrowseStore(backend: BrowseBackend) {
  return createStore<BrowseState>()((set, get) => {
    const update = (key: string, feed: Feed) =>
      set((state) => ({ feeds: { ...state.feeds, [key]: feed } }));

    /** Fetches the page after the feed's items. Callers check it is not loading. */
    async function fetchNext(source: BrowseSource, genre: string | undefined) {
      const key = feedKey(source, genre);
      const feed = get().feeds[key] ?? EMPTY;
      update(key, { ...feed, status: 'loading', error: null });

      const { addon, catalog } = source;
      let next: Feed;
      try {
        const raw = await backend.fetchResource(addon.transportUrl, {
          resource: 'catalog',
          type: catalog.type,
          id: catalog.id,
          extra: catalogExtra(genre, feed.next),
        });
        const parsed = parseCatalogResponse(raw);
        if (parsed.ok) {
          const received = parsed.value.metas.length + parsed.dropped;
          const items = appendPage(feed.items, parsed.value.metas).slice(0, MAX_FEED_ITEMS);
          next = {
            items,
            next: feed.next + received,
            // An empty or all-repeated page means the catalogue has run out.
            hasMore: items.length > feed.items.length && items.length < MAX_FEED_ITEMS,
            status: 'ready',
            error: null,
          };
        } else {
          next = { ...feed, status: 'error', error: 'The addon returned an invalid catalogue.' };
        }
      } catch (error) {
        next = { ...feed, status: 'error', error: describeError(error) };
      }
      // The feed was forgotten (its addon changed) while the page loaded.
      if (!(key in get().feeds)) return;
      update(key, next);
    }

    return {
      feeds: {},

      async load(source, genre) {
        if (get().feeds[feedKey(source, genre)]) return;
        await fetchNext(source, genre);
      },

      async loadMore(source, genre) {
        const feed = get().feeds[feedKey(source, genre)];
        if (feed?.status !== 'ready' || !feed.hasMore) return;
        await fetchNext(source, genre);
      },

      async retry(source, genre) {
        if (get().feeds[feedKey(source, genre)]?.status !== 'error') return;
        await fetchNext(source, genre);
      },

      forget(transportUrls) {
        const urls = new Set(transportUrls);
        set((state) => ({
          feeds: Object.fromEntries(
            Object.entries(state.feeds).filter(([key]) => !urls.has(feedAddon(key))),
          ),
        }));
      },
    };
  });
}

/** The transport URL a {@link feedKey} belongs to. */
function feedAddon(key: string): string {
  const [catalog] = JSON.parse(key) as [string, string | null];
  return (JSON.parse(catalog) as string[])[0] ?? '';
}

export const browseStore = createBrowseStore(addonCommands);

// Feeds of an addon that is updated (reinstalled) or uninstalled are stale.
addonsStore.subscribe((state, previous) => {
  if (state.addons === previous.addons) return;
  const manifests = new Map(state.addons.map((addon) => [addon.transportUrl, addon.manifest]));
  const stale = previous.addons
    .filter((addon) => manifests.get(addon.transportUrl) !== addon.manifest)
    .map((addon) => addon.transportUrl);
  if (stale.length > 0) browseStore.getState().forget(stale);
});

export function useBrowseStore<T>(selector: (state: BrowseState) => T): T {
  return useStore(browseStore, selector);
}
