import { parseCatalogResponse, type MetaPreview } from '@kiro/addon-sdk';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import {
  normalizeQuery,
  searchKey,
  uniqueItems,
  type SearchTarget,
} from '@/features/search/search-data';
import { addonCommands, describeError } from '@/services/native';

export type SearchEntry =
  | { status: 'loading' }
  | { status: 'ready'; items: MetaPreview[] }
  | { status: 'error'; message: string };

/** The native commands the store depends on; a fake is injected in tests. */
export type SearchBackend = Pick<typeof addonCommands, 'fetchResource'>;

export interface SearchState {
  /** The normalised query `entries` belong to; empty when there is none. */
  query: string;
  /** Results of each searched catalogue by {@link searchKey}. */
  entries: Record<string, SearchEntry>;

  /**
   * Searches every target for `query`, cancelling the previous search's
   * requests. Repeating the current search (same query and targets) does
   * nothing unless `force` is set. An empty query clears the results.
   */
  search: (targets: SearchTarget[], query: string, options?: { force?: boolean }) => Promise<void>;
  /** Searches one target of the current search again. */
  retry: (target: SearchTarget) => Promise<void>;
  /**
   * Cancels a search still in progress (e.g. on leaving the page) by
   * clearing it. A finished search is kept, so returning to it is instant.
   */
  cancel: () => void;
  /** Cancels any requests and clears the query and results. */
  clear: () => void;
}

const LOADING: SearchEntry = { status: 'loading' };

export function createSearchStore(backend: SearchBackend) {
  /** Aborts the current search's requests. */
  let controller: AbortController | null = null;
  /** Identifies the current search: its query and the keys of its targets. */
  let signature = '';

  return createStore<SearchState>()((set, get) => {
    async function fetchInto(target: SearchTarget, query: string, signal: AbortSignal) {
      const { addon, catalog } = target;
      let entry: SearchEntry;
      try {
        const raw = await backend.fetchResource(
          addon.transportUrl,
          { resource: 'catalog', type: catalog.type, id: catalog.id, extra: { search: query } },
          { signal },
        );
        const parsed = parseCatalogResponse(raw);
        entry = parsed.ok
          ? { status: 'ready', items: uniqueItems(parsed.value.metas) }
          : { status: 'error', message: 'The addon returned invalid results.' };
      } catch (error) {
        if (signal.aborted) return;
        entry = { status: 'error', message: describeError(error) };
      }
      // A newer search replaced this one while the request was in flight.
      if (signal.aborted) return;
      set((state) => ({ entries: { ...state.entries, [searchKey(target)]: entry } }));
    }

    return {
      query: '',
      entries: {},

      async search(targets, input, { force = false } = {}) {
        const query = normalizeQuery(input);
        const keys = targets.map(searchKey);
        const next = JSON.stringify([query, keys]);
        if (next === signature && !force) return;

        controller?.abort();
        controller = null;
        signature = next;
        if (!query || targets.length === 0) {
          set({ query, entries: {} });
          return;
        }

        const { signal } = (controller = new AbortController());
        set({ query, entries: Object.fromEntries(keys.map((key) => [key, LOADING])) });
        await Promise.all(targets.map((target) => fetchInto(target, query, signal)));
      },

      async retry(target) {
        const { query, entries } = get();
        const key = searchKey(target);
        if (!controller || !(key in entries) || entries[key]?.status === 'loading') return;
        set({ entries: { ...entries, [key]: LOADING } });
        await fetchInto(target, query, controller.signal);
      },

      cancel() {
        if (Object.values(get().entries).some((entry) => entry.status === 'loading')) {
          get().clear();
        }
      },

      clear() {
        controller?.abort();
        controller = null;
        signature = '';
        set({ query: '', entries: {} });
      },
    };
  });
}

export const searchStore = createSearchStore(addonCommands);

export function useSearchStore<T>(selector: (state: SearchState) => T): T {
  return useStore(searchStore, selector);
}
