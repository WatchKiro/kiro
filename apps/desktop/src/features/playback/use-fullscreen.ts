import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Fullscreen {
  active: boolean;
  toggle: () => void;
  exit: () => void;
}

/**
 * The window's fullscreen state, through Tauri's window API (only
 * `set_fullscreen` and `is_fullscreen` are granted, in
 * `capabilities/player.json`). On macOS this is native fullscreen, in its own
 * Space; on Windows and Linux the window covers the screen. The native video
 * surface resizes with the window on each.
 *
 * The state is set at once when toggling, then re-read whenever the window
 * resizes, which also catches leaving fullscreen another way (the green
 * button, the View menu). Leaving the page leaves fullscreen.
 */
export function useFullscreen(enabled: boolean): Fullscreen {
  const [active, setActive] = useState(false);
  const activeRef = useRef(active);
  const enabledRef = useRef(enabled);

  const set = useCallback((value: boolean) => {
    activeRef.current = value;
    setActive(value);
    getCurrentWindow()
      .setFullscreen(value)
      .catch(() => {
        // Not allowed or not supported: show the real state again.
        void getCurrentWindow()
          .isFullscreen()
          .then(
            (actual) => {
              activeRef.current = actual;
              setActive(actual);
            },
            () => undefined,
          );
      });
  }, []);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) return;
    let alive = true;
    const read = () =>
      getCurrentWindow()
        .isFullscreen()
        .then(
          (actual) => {
            if (!alive) return;
            activeRef.current = actual;
            setActive(actual);
          },
          () => undefined,
        );
    // macOS animates into and out of fullscreen; read once the size settles.
    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(read, 250);
    };
    void read();
    window.addEventListener('resize', onResize);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, [enabled]);

  // Leave fullscreen with the page (Back, or Up next opening a stream list).
  useEffect(
    () => () => {
      if (enabledRef.current && activeRef.current) {
        void getCurrentWindow()
          .setFullscreen(false)
          .catch(() => undefined);
      }
    },
    [],
  );

  const toggle = useCallback(() => set(!activeRef.current), [set]);
  const exit = useCallback(() => {
    if (activeRef.current) set(false);
  }, [set]);
  return { active, toggle, exit };
}
