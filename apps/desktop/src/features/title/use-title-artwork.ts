import { useEffect, useMemo } from 'react';

import { useAddonsStore } from '@/features/addons/addons-store';
import { displayableImage } from '@/features/addons/catalog';
import { groupSeasons, metaAddons, metaKey, type Season } from '@/features/title/title-data';
import { useTitleStore } from '@/features/title/title-store';

/**
 * A title's backdrop, logo and episodes from its details, for cards that only know its
 * id (the library stores a poster). Details are fetched once `enabled`, and
 * cached by the title store, so opening the title afterwards is instant.
 */
export function useTitleArtwork(type: string, id: string, enabled: boolean) {
  const addons = useAddonsStore((state) => state.addons);
  const ready = useAddonsStore((state) => state.status === 'ready');
  const sources = useMemo(() => metaAddons(addons, type, id), [addons, type, id]);
  const entry = useTitleStore((state) => state.metas[metaKey(type, id, sources)]);
  const loadMeta = useTitleStore((state) => state.loadMeta);

  useEffect(() => {
    if (enabled && ready) void loadMeta(addons, type, id);
  }, [enabled, ready, addons, type, id, loadMeta]);

  const meta = entry?.status === 'ready' ? entry.meta : undefined;
  /** The episodes: `undefined` while loading, `null` if details couldn't be loaded. */
  const seasons = useMemo<Season[] | null | undefined>(
    () => (meta ? groupSeasons(meta.videos ?? []) : entry?.status === 'error' ? null : undefined),
    [meta, entry?.status],
  );
  return {
    background: displayableImage(meta?.background),
    logo: displayableImage(meta?.logo),
    seasons,
  };
}
