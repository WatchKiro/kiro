import { useCallback, useEffect, useMemo } from 'react';

import type { BrowseSource } from '@/features/discovery/browse-data';
import {
  capLayout,
  resolveLayout,
  type ResolvedLayout,
  type RowPage,
} from '@/features/discovery/row-layout';
import { useSettingsStore } from '@/features/settings/settings-store';
import type { CatalogRowSetting } from '@/services/native';

export interface RowLayout extends ResolvedLayout {
  /** Whether the saved layout has been read (the default shows until then). */
  ready: boolean;
  /** Saves a changed layout for the page. */
  save: (entries: CatalogRowSetting[]) => void;
  /** Back to every catalogue in addon order. */
  reset: () => void;
}

/**
 * A page's rows: `sources` (in default order) arranged by its saved layout.
 * Without a `page` there is nothing saved: the default order, and `save` and
 * `reset` do nothing.
 */
export function useRowLayout(page: RowPage | undefined, sources: BrowseSource[]): RowLayout {
  const status = useSettingsStore((state) => state.status);
  const saved = useSettingsStore((state) => (page ? state.settings.rows[page] : null));
  const load = useSettingsStore((state) => state.load);
  const updateRows = useSettingsStore((state) => state.updateRows);

  useEffect(() => void load(), [load]);

  const resolved = useMemo(() => resolveLayout(sources, saved), [sources, saved]);
  const available = useMemo(() => new Set(resolved.rows.map((row) => row.key)), [resolved]);

  const save = useCallback(
    (entries: CatalogRowSetting[]) => {
      if (page) void updateRows(page, capLayout(entries, available));
    },
    [updateRows, page, available],
  );
  const reset = useCallback(() => {
    if (page) void updateRows(page, null);
  }, [updateRows, page]);

  return {
    ...resolved,
    // A failed read leaves the default layout, which is still usable.
    ready: status === 'ready' || status === 'error',
    save,
    reset,
  };
}
