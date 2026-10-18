import { useEffect, useState, useSyncExternalStore } from 'react';

import { NativePlayer, type NativePlayerView } from '@/features/playback/native-player';
import { tauriPlayerBridge, type PlayerBridge } from '@/services/player';

export interface NativePlayerHandle {
  /** The player while mounted (commands wait until it is attached). */
  player: NativePlayer | null;
  /** Whether the native player is attached and its state is known. */
  ready: boolean;
  /** Why attaching failed, if it did. */
  attachError: string | null;
  view: NativePlayerView | null;
}

type Attachment = Omit<NativePlayerHandle, 'view'>;

const DETACHED: Attachment = { player: null, ready: false, attachError: null };
const noSubscription = () => () => undefined;
const noView = () => null;

/** Holds the current attachment outside React, so the effect only updates an external store. */
function createAttachmentStore() {
  let value = DETACHED;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: Attachment) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Attaches the native player for the lifetime of the calling component and
 * detaches it on unmount (which also stops playback). StrictMode remounts are
 * safe: `NativePlayer` queues attach/detach in call order.
 */
export function useNativePlayer(
  enabled: boolean,
  bridge: PlayerBridge = tauriPlayerBridge,
): NativePlayerHandle {
  const [store] = useState(createAttachmentStore);

  useEffect(() => {
    if (!enabled) return;
    const player = NativePlayer.attach(bridge);
    store.set({ player, ready: false, attachError: null });
    player.ready.then(
      () => store.get().player === player && store.set({ player, ready: true, attachError: null }),
      (reason: unknown) =>
        store.get().player === player &&
        store.set({
          player,
          ready: false,
          attachError: reason instanceof Error ? reason.message : String(reason),
        }),
    );
    return () => {
      store.set(DETACHED);
      void player.destroy().catch(() => undefined);
    };
  }, [enabled, bridge, store]);

  const attachment = useSyncExternalStore(store.subscribe, store.get);
  const { player } = attachment;
  const view = useSyncExternalStore(player?.subscribe ?? noSubscription, player?.getView ?? noView);
  return { ...attachment, view };
}
