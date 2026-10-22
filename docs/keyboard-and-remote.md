# Keyboard and remote control

Kiro can be used from a sofa with arrows, Enter and Back, as on a TV. The same code will drive a future Android TV build, where a remote's D-pad arrives as arrow keys. This page covers the keys, how focus moves, what remotes send, and how pages opt in.

`?` opens the shortcuts overlay anywhere in the app, and Settings has a button for it.

## Keys

| Keys              | Everywhere                                                                            |
| ----------------- | ------------------------------------------------------------------------------------- |
| ↑ ↓ ← →           | Move focus to the nearest item that way                                               |
| Enter, Space      | Open or press what is focused                                                         |
| Escape, Backspace | Go back (history back, or Discover from a first page). Never while typing in a field. |
| ⌘K / Ctrl K       | Search                                                                                |
| ?                 | Keyboard shortcuts                                                                    |
| Tab, Shift Tab    | Unchanged: document order                                                             |

| Keys       | Player                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Space      | Play or pause (even with a control focused)                                                                                     |
| ← →        | Skip back or forward (Settings → Playback sets how far), unless a control was focused with the keys: then ← → move between them |
| ↑ ↓        | Bring up the controls, then move between the seek bar, the control bar and the top bar                                          |
| M, F, H    | Mute, full screen, hide or show the controls                                                                                    |
| S          | Skip the intro or credits while the button shows; so does Enter (a remote's OK) with nothing focused                            |
| Z X        | Subtitles 0.1 s earlier or later (for the subtitle track showing)                                                               |
| J K        | Audio 0.1 s earlier or later                                                                                                    |
| [ ]        | Slower or faster: 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2×                                                                              |
| Escape     | Close the open panel (streams, subtitles and audio, sync and speed), else leave full screen, else go back                       |
| Backspace  | Go back                                                                                                                         |
| Media keys | Play/pause, play, pause, next episode, start over, skip back/forward, stop (go back)                                            |

Typing is never navigation: in a text field, letters, Space, Backspace and Escape belong to the field (Escape clears the search, then leaves it). Up and Down leave a single-line field, and Left and Right leave it only past the start or end of its text (not when the key is held).

## How focus moves

`apps/desktop/src/features/remote/`:

| File                   | What                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `spatial.ts`           | Pure geometry: candidates by direction, nearest candidate, focus groups with memory. Unit-tested (`spatial.test.ts`).  |
| `keys.ts`              | What a key press means (`keyAction`), and whether a field owns an arrow (`ownsArrow`). Unit-tested (`keys.test.ts`).   |
| `remote-navigation.ts` | The DOM side: one capture-phase `keydown` listener on the window, focus memory, scrolling, restoring focus after Back. |
| `shortcuts-help.tsx`   | The `?` overlay.                                                                                                       |

The rules for choosing the next item follow Android's FocusFinder: only items wholly further in the direction count; an item that overlaps the current one across the direction of travel (the next poster in a row) beats one that doesn't; otherwise the nearest wins, by a distance that weighs the direction of travel 13 times more than the sideways offset. On top of that:

- **Rows remember.** Entering a group (a row, a grid, the sidebar, a set of tabs) lands on the item last focused in it, else its current item (`aria-current`, `aria-selected`, `aria-checked`), else the nearest one in line.
- **Rows end.** Left and Right stay in a row and stop at its end, rather than dropping into the next row. Left at a row's start reaches the sidebar.
- **The header comes last.** The floating header is only reached when nothing else lies that way, so Up from the first row reaches the hero first.
- **The sidebar is beside the page.** Left and Right enter and leave it; Up and Down stay inside it.
- **Scrolling** brings the focused item into view smoothly (instantly with reduced motion), clear of the header, and keeps a row from snapping a card half out of view.
- **Back restores focus**: going back to a page focuses the item that was focused there. Opening a page with the keys focuses its main action (Play on Discover and on a title).
- **At an edge** nothing moves and the key does what it normally does, such as scrolling the rest of a page into view.
- **No traps.** Faded-out player controls give up focus when they hide, so Enter can't press what can't be seen; the next arrow brings them back. Menus (`data-nav-layer`) keep the arrows in while open and return focus to their button when closed.
- **Customise.** The row editor on Discover, Movies and TV Shows is a layer: arrows move between its buttons and switches, Escape or Back closes it. Moving or hiding a row keeps focus on that control (or the next row's); see [discover.md](discover.md#customising).
- **Who’s watching?** The profile picker and its PIN pad are layers: arrows move between the tiles (or the on-screen digits, which can also be typed), Enter chooses, and Back returns from the PIN pad to the tiles or closes a picker opened to switch. See [profiles.md](profiles.md#keyboard-and-remote).
- **First-run setup.** A layer over the app: focus starts on the link field, and Escape or Back skips it (not while typing). See [first-run.md](first-run.md#keyboard-and-remote).
- **Over the video.** Skip intro/credits and Up next sit above the control bar and are reached with Up; while the controls are hidden, the first arrow lands on Skip. The resume prompt keeps the arrows on its two buttons.

Focus shows as a violet ring (`focus-ring`) on buttons, chips and tabs, and as a lift with a glow (`focus-lift`) on posters and cards, both in `packages/ui/src/styles.css`. They appear for keys and not for clicks: `focus-visible:` matches `:focus-visible`, or `[data-nav-focus]`, which the navigation sets on elements it focuses because WebKit doesn't treat script focus as visible after a click.

## For pages

Plain focusable elements need nothing. Data attributes steer the rest:

| Attribute                             | Effect                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `data-nav-group`                      | A row, grid, tab list or column that remembers its last focused item                                  |
| `data-nav-start`                      | Where focus starts on a page (Play)                                                                   |
| `data-nav-forget`                     | An item its group shouldn't return to (a row's "See all")                                             |
| `data-nav-layer`                      | A menu or dialog: arrows stay inside, Back is left to it                                              |
| `data-nav-keys="back space sideways"` | The page handles these keys itself (the player). `sideways` keeps ← → unless a control has key focus. |
| `data-nav-own="sideways"`             | A widget that moves with Left and Right itself (a roving-focus radio group); Up and Down move on      |
| `data-nav-skip`                       | Arrows pass this element (or everything inside it) by; Tab still reaches it                           |
| `data-nav-fallback`                   | Reached only when nothing else lies that way (the header)                                             |
| `data-nav-side`                       | A side column (the sidebar), entered with Left and Right only                                         |

Pages that handle keys themselves should skip events that are already `defaultPrevented`: the navigation runs first and marks the keys it used.

## What remotes send

| Button                | Typically arrives as                                                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-pad                 | `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`, on every platform                                                                                                                                                                                                                       |
| OK / Select / centre  | `Enter` (Android's `DPAD_CENTER` too)                                                                                                                                                                                                                                                   |
| Back                  | Android TV: `KEYCODE_BACK` goes to the activity, not the page, so the Android shell must forward it (for example as `Escape`, or by calling `history.back()`). LG webOS: key code 461. Samsung Tizen: key code 10009 (`XF86Back`). Air mice and HID remotes: `BrowserBack` or `Escape`. |
| Play/Pause            | `MediaPlayPause`; HbbTV-style TVs send Play (415) and Pause (19) separately. Tizen needs media keys registered (`tizen.tvinputdevice.registerKey`) before it sends them.                                                                                                                |
| Fast-forward / rewind | `MediaFastForward` / `MediaRewind` (417 / 412 on HbbTV-style TVs)                                                                                                                                                                                                                       |
| Next / previous       | `MediaTrackNext` / `MediaTrackPrevious`                                                                                                                                                                                                                                                 |
| Stop                  | `MediaStop` (413)                                                                                                                                                                                                                                                                       |
| Colour buttons        | 403–406 (red, green, yellow, blue): not used yet                                                                                                                                                                                                                                        |

`keys.ts` maps all of these, including the key codes TV browsers send without a `key` value.

On macOS the system sends the keyboard's media keys (F7–F9) to the app that owns "Now Playing". Kiro's video plays in libmpv rather than in the webview, so the webview has no media session and usually doesn't receive them; a later change can register the player with `MPRemoteCommandCenter` on the Rust side and forward the commands.

## Testing

- `pnpm --filter @kiro/desktop test` runs the geometry and key tests.
- In the browser preview (`pnpm --filter @kiro/desktop dev:renderer`), click once into the page so it has focus, then use the keys. A script can dispatch `keydown` events on `document.activeElement` and read which element has focus.
