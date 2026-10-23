import { exit, onBackButtonPress } from '@tauri-apps/api/app';

/** Set by the Tauri CLI for the renderer it builds (`android`, `macos`, ...). */
export const IS_ANDROID = import.meta.env.TAURI_ENV_PLATFORM === 'android';

/**
 * Android TV: the remote's Back button doesn't reach the page as a key, and
 * left alone Android steps back through the webview's history and then
 * leaves the app, past any open menu or dialog. Send it into the page as
 * Escape instead, the key every menu, dialog and page already takes as Back
 * (close a menu, leave a page, the player's own Back), and leave the app
 * only when nothing took it: Back on the home page.
 */
export function installAndroidBack(): void {
  if (!IS_ANDROID) return;
  void onBackButtonPress(() => {
    const target = document.activeElement ?? document.body;
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    if (!event.defaultPrevented) void exit(0);
  });
}
