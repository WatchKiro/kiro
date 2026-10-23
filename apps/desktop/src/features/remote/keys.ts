import type { Direction } from '@/features/remote/spatial';

/**
 * What a key press means to Kiro, from keyboards and remote controls alike.
 *
 * A remote's D-pad arrives as arrow keys and OK as Enter on every platform.
 * Back and the media keys vary: desktop keyboards send `Media*` keys (which
 * the system often keeps for itself), Android TV sends `GoBack`/`BrowserBack`
 * for Back where the app lets it through, and TV browsers (webOS, Tizen,
 * HbbTV) send their own key codes. See docs/keyboard-and-remote.md.
 */
export type KeyAction =
  | { kind: 'move'; direction: Direction }
  | { kind: 'activate' }
  | { kind: 'back' }
  /** Open the focused item's menu of actions (a card's "Mark as watched", …). */
  | { kind: 'menu' }
  | { kind: 'help' }
  | { kind: 'media'; command: MediaCommand };

export type MediaCommand =
  'playPause' | 'play' | 'pause' | 'stop' | 'next' | 'previous' | 'fastForward' | 'rewind';

/** The parts of a `KeyboardEvent` that decide its meaning. */
export interface KeyInput {
  key: string;
  /** Legacy key code: TV browsers report some remote buttons only this way. */
  keyCode?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

const DIRECTIONS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const MEDIA_KEYS: Record<string, MediaCommand> = {
  MediaPlayPause: 'playPause',
  MediaPlay: 'play',
  MediaPause: 'pause',
  MediaStop: 'stop',
  MediaTrackNext: 'next',
  MediaTrackPrevious: 'previous',
  MediaFastForward: 'fastForward',
  MediaRewind: 'rewind',
};

/** Remote buttons that TV browsers report by key code alone (HbbTV/webOS/Tizen). */
const TV_KEY_CODES: Record<number, KeyAction> = {
  461: { kind: 'back' }, // webOS Back
  10009: { kind: 'back' }, // Tizen Return
  415: { kind: 'media', command: 'play' },
  19: { kind: 'media', command: 'pause' },
  413: { kind: 'media', command: 'stop' },
  417: { kind: 'media', command: 'fastForward' },
  412: { kind: 'media', command: 'rewind' },
  10252: { kind: 'media', command: 'playPause' }, // Tizen Play/Pause
};

/**
 * The action a key press asks for, or `null`. Presses with ⌘, Ctrl or Alt are
 * shortcuts (⌘K, ⌘←) and never navigate; media keys work regardless.
 */
export function keyAction(input: KeyInput): KeyAction | null {
  const media = MEDIA_KEYS[input.key];
  if (media) return { kind: 'media', command: media };
  if (input.altKey || input.ctrlKey || input.metaKey) return null;

  const direction = DIRECTIONS[input.key];
  if (direction) return { kind: 'move', direction };
  switch (input.key) {
    case 'Enter':
    case ' ':
      return { kind: 'activate' };
    case 'Escape':
    case 'Backspace':
    case 'GoBack':
    case 'BrowserBack':
      return { kind: 'back' };
    case '?':
      return { kind: 'help' };
    // The keyboard's Menu key (an Android TV remote's Menu button arrives as
    // it too), and Shift F10 on keyboards without one.
    case 'ContextMenu':
      return { kind: 'menu' };
    case 'F10':
      if (input.shiftKey) return { kind: 'menu' };
  }
  return (input.keyCode !== undefined && TV_KEY_CODES[input.keyCode]) || null;
}

/** The parts of an element that decide whether keys type into it. */
export interface FieldLike {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
  /** The caret, for fields that have one (`null` for those that don't). */
  selectionStart?: number | null;
  selectionEnd?: number | null;
  value?: string;
  /** A read-only text field takes no typing, so its arrows navigate. */
  readOnly?: boolean;
}

/** Input types that take no text, so keys pressed on them can navigate. */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Whether keys pressed on `element` type text (search, URLs, notes). */
export function isTextField(element: FieldLike | null | undefined): boolean {
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  return tag === 'INPUT' && !NON_TEXT_INPUTS.has((element.type ?? 'text').toLowerCase());
}

/**
 * Whether an arrow key on `element` is the element's own: moving the caret
 * in a text field, changing a slider, or anything at all in a text area.
 * Up and Down leave a single-line text field, as nothing else uses them
 * there, and so do Left at the start and Right at the end of its text (but
 * not a held key, which would run on past the text).
 */
export function ownsArrow(
  element: FieldLike | null | undefined,
  direction: Direction,
  repeat = false,
): boolean {
  if (!element) return false;
  const tag = element.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || element.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  const type = (element.type ?? 'text').toLowerCase();
  const sideways = direction === 'left' || direction === 'right';
  if (type === 'range') return sideways;
  if (!isTextField(element) || !sideways || element.readOnly) return false;
  const { selectionStart: start, selectionEnd: end, value = '' } = element;
  if (repeat || start == null || start !== end) return true;
  return direction === 'left' ? start > 0 : start < value.length;
}
