import {
  parseMetaResponse,
  parseStreamResponse,
  type MetaDetail,
  type Stream,
} from '@kiro/addon-sdk';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import type { InstalledAddon } from '@/features/addons/addons-store';
import { metaAddons, metaKey, streamAddons, streamsKey } from '@/features/title/title-data';
import { addonCommands, describeError } from '@/services/native';

export type MetaEntry =
  | { status: 'loading' }
  | { status: 'ready'; meta: MetaDetail; addonName: string }
  | { status: 'error'; message: string };

export type StreamsEntry =
  | { status: 'loading' }
  | { status: 'ready'; streams: Stream[] }
  | { status: 'error'; message: string };

/** The native commands the store depends on; a fake is injected in tests. */
export type TitleBackend = Pick<typeof addonCommands, 'fetchResource'>;

export interface TitleState {
  /** Metadata by {@link metaKey}, kept across navigation. */
  metas: Record<string, MetaEntry>;
  /** One addon's streams by {@link streamsKey}, kept across navigation. */
  streams: Record<string, StreamsEntry>;

  /**
   * Fetches a title's metadata from the first addon (in install order) that
   * supports it and returns a valid response. Skipped if loading or fetched
   * unless `force` is set.
   */
  loadMeta: (
    addons: InstalledAddon[],
    type: string,
    id: string,
    options?: { force?: boolean },
  ) => Promise<void>;
  /** Fetches streams from every addon that supports `type`/`id`, in parallel. */
  loadStreams: (addons: InstalledAddon[], type: string, id: string) => Promise<void>;
  /** Fetches one addon's streams unless loading or fetched (`force` refetches). */
  loadAddonStreams: (
    addon: InstalledAddon,
    type: string,
    id: string,
    options?: { force?: boolean },
  ) => Promise<void>;
}

export function createTitleStore(backend: TitleBackend) {
  return createStore<TitleState>()((set, get) => ({
    metas: {},
    streams: {},

    async loadMeta(installed, type, id, { force = false } = {}) {
      const addons = metaAddons(installed, type, id);
      const key = metaKey(type, id, addons);
      const current = get().metas[key];
      if (current?.status === 'loading' || (current && !force)) return;

      const update = (entry: MetaEntry) =>
        set((state) => ({ metas: { ...state.metas, [key]: entry } }));

      if (addons.length === 0) {
        update({
          status: 'error',
          message: 'None of your installed addons provide details for this title.',
        });
        return;
      }
      update({ status: 'loading' });

      let firstError: string | undefined;
      for (const addon of addons) {
        try {
          const raw = await backend.fetchResource(addon.transportUrl, {
            resource: 'meta',
            type,
            id,
          });
          const parsed = parseMetaResponse(raw);
          if (parsed.ok) {
            update({ status: 'ready', meta: parsed.value.meta, addonName: addon.manifest.name });
            return;
          }
          firstError ??= `${addon.manifest.name} returned invalid details.`;
        } catch (error) {
          firstError ??= `${addon.manifest.name}: ${describeError(error)}`;
        }
      }
      update({ status: 'error', message: firstError ?? 'Details could not be loaded.' });
    },

    async loadStreams(installed, type, id) {
      const { loadAddonStreams } = get();
      await Promise.all(
        streamAddons(installed, type, id).map((addon) => loadAddonStreams(addon, type, id)),
      );
    },

    async loadAddonStreams(addon, type, id, { force = false } = {}) {
      const key = streamsKey(addon.transportUrl, type, id);
      const current = get().streams[key];
      if (current?.status === 'loading' || (current && !force)) return;

      const update = (entry: StreamsEntry) =>
        set((state) => ({ streams: { ...state.streams, [key]: entry } }));
      update({ status: 'loading' });

      try {
        const raw = await backend.fetchResource(addon.transportUrl, {
          resource: 'stream',
          type,
          id,
        });
        const parsed = parseStreamResponse(raw);
        update(
          parsed.ok
            ? { status: 'ready', streams: parsed.value.streams }
            : { status: 'error', message: 'The addon returned an invalid stream list.' },
        );
      } catch (error) {
        update({ status: 'error', message: describeError(error) });
      }
    },
  }));
}

export const titleStore = createTitleStore(addonCommands);

export function useTitleStore<T>(selector: (state: TitleState) => T): T {
  return useStore(titleStore, selector);
}
