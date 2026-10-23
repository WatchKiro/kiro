import { NavigationType } from 'react-router';

import type { router as appRouter } from '@/app/router';
import { isTextField, keyAction, ownsArrow } from '@/features/remote/keys';
import { useShortcutsHelpStore } from '@/features/remote/shortcuts-store';
import { FocusMemory, chooseMove, type Direction, type NavItem } from '@/features/remote/spatial';

/**
 * Keyboard and remote-control navigation for the whole app: arrows move focus
 * by on-screen position, Enter and Space activate, Escape and Backspace go
 * back, the Menu key (or Shift F10) opens the focused card's menu as a right
 * click would (a `contextmenu` event), `?` shows the shortcuts. Tab order, the mouse and screen readers work
 * as before; this only adds keys.
 *
 * Pages steer it with data attributes:
 * - `data-nav-group` on a row, grid or the sidebar: returning to it lands on
 *   the item last focused there (or its current item, `aria-current` and the
 *   like, the first time).
 * - `data-nav-entry` on a region beside a side column (a section of
 *   Settings): coming from the column, focus lands on the item last focused
 *   in it, else its first, rather than the nearest.
 * - `data-nav-forget` on an item a group shouldn't return to, such as a
 *   row's "See all" above its posters.
 * - `data-nav-start` on the item focus starts from on a page, such as Play.
 * - `data-nav-layer` on a menu or dialog: arrows stay inside it, and Back is
 *   left to it to close itself.
 * - `data-nav-keys="back space sideways"` on a page that handles those keys
 *   itself (the player); `sideways` is Left/Right, unless a control has been
 *   focused with the keys.
 * - `data-nav-own="sideways"` around a widget that moves with Left and Right
 *   itself (a radio group with roving focus); Up and Down still move on.
 *   `data-nav-own="back"`: a widget that handles Back itself while focused
 *   (a notice closing).
 * - `data-nav-skip` on an element (or around elements) arrows should pass by.
 * - `data-nav-fallback` around items reached only when nothing else lies that
 *   way, such as the floating header over the page's top.
 * - `data-nav-side` on a column beside the page (the sidebar), entered only
 *   with Left and Right.
 */

type Router = typeof appRouter;
type Item = NavItem<HTMLElement, HTMLElement>;

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';
/** What a group is entered on the first time. */
const PREFERRED =
  '[data-nav-start], [aria-current]:not([aria-current="false"]), [aria-selected="true"], [aria-checked="true"]';
/** Set on the focused element while focus came from the keys, for the focus style. */
const KEY_FOCUS_ATTRIBUTE = 'data-nav-focus';
/** How long to wait for a page's content before giving up on focusing it. */
const SETTLE_MS = 3000;

let usingKeys = false;
const memory = new FocusMemory<HTMLElement, HTMLElement>();

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Whether `element` is laid out and not `visibility: hidden`. Transparent
 * elements count (a colour input drawn over its label, controls still fading
 * in); controls faded out of the way are marked `data-nav-skip` instead.
 */
function isShown(element: HTMLElement) {
  if (element.getClientRects().length === 0) return false;
  return element.checkVisibility?.({ visibilityProperty: true }) ?? true;
}

/** Whether arrows can move focus to `element`. */
function isNavigable(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.tabIndex >= 0 &&
    !element.matches(':disabled, input[type="hidden"]') &&
    !element.closest('[inert], [aria-hidden="true"], [data-nav-skip]') &&
    isShown(element)
  );
}

/** The open menu or dialog arrows are confined to, if any. */
function topLayer(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-nav-layer]')]
    .filter((layer) => isShown(layer))
    .at(-1);
}

/** Keys the page handles itself (see `data-nav-keys`). */
function pageKeys(): string[] {
  return document.querySelector<HTMLElement>('[data-nav-keys]')?.dataset.navKeys?.split(' ') ?? [];
}

function groupsOf(element: Element, scope: Element): HTMLElement[] {
  const groups: HTMLElement[] = [];
  for (
    let group = element.closest<HTMLElement>('[data-nav-group]');
    group && scope.contains(group);
    group = group.parentElement?.closest<HTMLElement>('[data-nav-group]') ?? null
  ) {
    groups.push(group);
  }
  return groups;
}

function navigables(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll(FOCUSABLE)].filter(isNavigable);
}

function inViewport(element: Element) {
  const rect = element.getBoundingClientRect();
  return (
    rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < innerWidth
  );
}

/**
 * Where focus starts when nothing is focused: the page's `data-nav-start`,
 * else its first item, as long as it is on screen (no jumping back up a page
 * scrolled with the mouse).
 */
function startOf(scope: ParentNode): HTMLElement | undefined {
  const shown = navigables(scope).filter(inViewport);
  const content = (element: HTMLElement) =>
    Boolean(element.closest('main')) && !element.closest('header');
  return (
    shown.find((element) => element.matches('[data-nav-start]')) ?? shown.find(content) ?? shown[0]
  );
}

/**
 * Focuses `element` as the keys would, scrolling it (smoothly) into view. Its
 * focus shows when the keys are in use (not after a click that opened a menu).
 */
export function focusWithKeys(element: HTMLElement) {
  element.focus({ preventScroll: true, focusVisible: usingKeys });
  element.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    behavior: reducedMotion() ? 'auto' : 'smooth',
  });
}

/**
 * Up to the first item on a page scrolls the page back to its top, so what
 * sits above that item (a banner, the page title) shows again instead of
 * staying scrolled away under the header.
 */
function revealPageTop(target: HTMLElement) {
  const page = target.closest('main');
  if (!page || target.closest('header')) return;
  const first = navigables(page).find((element) => !element.closest('header'));
  if (first !== target) return;
  page.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

/** The element arrows move from: what is focused, when it is on the page in `scope`. */
function currentFocus(scope: Element): HTMLElement | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return undefined;
  if (!scope.contains(active) || active.getClientRects().length === 0) return undefined;
  return active;
}

/** How far a side column lies from `from`, sideways in `direction`. */
function columnGap(from: Element, column: Element, direction: Direction): number {
  const a = from.getBoundingClientRect();
  const b = column.getBoundingClientRect();
  return direction === 'left' ? a.left - b.right : b.left - a.right;
}

/** Moves focus `direction`. Returns whether it did. */
function move(direction: Direction): boolean {
  const scope = topLayer() ?? document.body;
  const active = currentFocus(scope);
  if (!active) {
    const start = topLayer() ? startOfLayer(scope) : startOf(scope);
    if (start) focusWithKeys(start);
    return Boolean(start);
  }
  const sideways = direction === 'left' || direction === 'right';
  const side = active.closest('[data-nav-side]');
  const candidates: Item[] = navigables(scope)
    .filter((element) => sideways || element.closest('[data-nav-side]') === side)
    .map((element) => ({
      target: element,
      rect: element.getBoundingClientRect(),
      groups: groupsOf(element, scope),
    }));
  const choose = (pool: Item[]) =>
    chooseMove({
      source: { rect: active.getBoundingClientRect(), groups: groupsOf(active, scope) },
      candidates: pool,
      direction,
      memory,
      isPreferred: (candidate) => candidate.target.matches(PREFERRED),
      groupRect: (group) => group.getBoundingClientRect(),
      // From the sidebar, Right goes to the nearest thing on the page even
      // when nothing is level with it.
      freeSideways: Boolean(side),
    });
  // The header floats over the page: Up reaches the hero beneath it first.
  const fallback = (item: Item) => Boolean(item.target.closest('[data-nav-fallback]'));
  // Side columns are beside the page: sideways from it, the page comes
  // first, then the nearest column (Settings' list of sections before the
  // sidebar).
  const columnOf = (item: Item) => (side ? null : item.target.closest('[data-nav-side]'));
  const columns = [...new Set(candidates.map(columnOf))]
    .filter((column) => column !== null)
    .toSorted((a, b) => columnGap(active, a, direction) - columnGap(active, b, direction));
  const pools = [
    candidates.filter((item) => !fallback(item) && columnOf(item) === null),
    ...columns.map((column) => candidates.filter((item) => columnOf(item) === column)),
  ];
  const next = active.closest('[data-nav-fallback]')
    ? choose(candidates)
    : (pools.reduce<Item | undefined>((found, pool) => found ?? choose(pool), undefined) ??
      choose(candidates));
  const target = next && side ? entryOf(next.target, side) : next?.target;
  if (target) {
    focusWithKeys(target);
    if (direction === 'up') revealPageTop(target);
  }
  return Boolean(target);
}

/** The last item focused in each `data-nav-entry` region. */
const entries = new WeakMap<Element, HTMLElement>();

/**
 * Where a move from the side column `side` onto `target` lands: inside a
 * `data-nav-entry` region, the item last focused there, else its first
 * (passing over `data-nav-forget` ones, such as a section's reset).
 */
function entryOf(target: HTMLElement, side: Element): HTMLElement {
  const region = target.closest('[data-nav-entry]');
  if (!region || region.contains(side)) return target;
  const last = entries.get(region);
  if (last && region.contains(last) && isNavigable(last)) return last;
  return navigables(region).find((item) => !item.hasAttribute('data-nav-forget')) ?? target;
}

/** The item a menu or dialog starts on: its selected option, or its first item. */
export function startOfLayer(layer: ParentNode): HTMLElement | undefined {
  const items = navigables(layer);
  return items.find((element) => element.matches(PREFERRED)) ?? items[0];
}

/** Enter and Space on things the browser doesn't activate with them. */
function activate(event: KeyboardEvent, active: Element | null): boolean {
  if (!(active instanceof HTMLElement) || active === document.body) return false;
  // Buttons, form fields and <summary> already take both keys.
  if (active.matches('button, input, select, textarea, summary')) return false;
  const link = active.matches('a[href]');
  // Links take Enter; Space would scroll the page.
  if (link ? event.key !== ' ' : !active.matches('[role]')) return false;
  active.click();
  return true;
}

/**
 * Asks the focused item for its menu with a `contextmenu` event, placed at
 * its top right corner. Whether something opened one (cancelled the event).
 */
function openMenu(active: HTMLElement | null): boolean {
  if (!active || active === document.body || isTextField(active)) return false;
  const rect = active.getBoundingClientRect();
  return !active.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.right,
      clientY: rect.top,
    }),
  );
}

/** Returns false on the home page, with nothing to go back to. */
function goBack(router: Router): boolean {
  const { location } = router.state;
  // `default` is the first entry of this session: nothing to go back to.
  if (location.key !== 'default') void router.navigate(-1);
  else if (location.pathname !== '/') void router.navigate('/');
  else return false;
  return true;
}

function onKeyDown(router: Router, event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return;
  const action = keyAction(event);
  usingKeys = action !== null || event.key === 'Tab' || usingKeys;
  if (!action) return;
  const active = document.activeElement;
  const field = active instanceof HTMLElement ? active : null;
  const keys = pageKeys();

  let handled = false;
  switch (action.kind) {
    case 'move': {
      if (ownsArrow(field, action.direction, event.repeat)) return;
      const sideways = action.direction === 'left' || action.direction === 'right';
      if (sideways && field?.closest('[data-nav-own~="sideways"]')) return;
      // A page that seeks with Left/Right still lets them move between its
      // controls once those are being used with the keys (and not seek at
      // the last one).
      if (sideways && keys.includes('sideways') && !topLayer()) {
        if (!field || !field.hasAttribute(KEY_FOCUS_ATTRIBUTE) || !isNavigable(field)) return;
        move(action.direction);
        handled = true;
        break;
      }
      // With nothing further that way, the key scrolls as usual (the end of
      // a page, below its last control).
      handled = move(action.direction);
      break;
    }
    case 'activate':
      if (event.key === ' ' && keys.includes('space')) return;
      handled = activate(event, active);
      break;
    case 'back':
      // Typing (Backspace deletes, Escape clears the search), an open menu or
      // dialog, a widget or page with its own Back.
      if (isTextField(field) || topLayer() || keys.includes('back')) return;
      if (field?.closest('[data-nav-own~="back"]')) return;
      handled = goBack(router);
      break;
    case 'menu':
      handled = openMenu(field);
      break;
    case 'help':
      if (isTextField(field)) return;
      useShortcutsHelpStore.getState().toggle();
      handled = true;
      break;
    case 'media':
      // The player handles these; elsewhere there is nothing to play.
      return;
  }
  if (handled) event.preventDefault();
}

/** Remembers how focus arrived, for the focus style and for row memory. */
function onFocusIn(router: Router, event: FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (usingKeys) target.setAttribute(KEY_FOCUS_ATTRIBUTE, '');
  if (!target.hasAttribute('data-nav-forget')) {
    memory.remember(groupsOf(target, document.body), target);
    const region = target.closest('[data-nav-entry]');
    if (region) entries.set(region, target);
  }
  if (target.closest('main')) snapshots.set(router.state.location.key, describe(target));
}

function onFocusOut(event: FocusEvent) {
  if (event.target instanceof HTMLElement) event.target.removeAttribute(KEY_FOCUS_ATTRIBUTE);
}

/** What was focused on a page, to find it again on coming back. */
interface FocusSnapshot {
  identity: string;
  /** Among items with the same identity (a title in two rows), which one. */
  ordinal: number;
}

/** Last focused item per history entry. */
const snapshots = new Map<string, FocusSnapshot>();

function identityOf(element: HTMLElement) {
  return (
    element.getAttribute('href') ??
    element.getAttribute('aria-label') ??
    element.textContent.trim().slice(0, 80)
  );
}

function describe(element: HTMLElement): FocusSnapshot {
  const identity = identityOf(element);
  const same = navigables(document).filter((other) => identityOf(other) === identity);
  return { identity, ordinal: Math.max(0, same.indexOf(element)) };
}

function find(snapshot: FocusSnapshot): HTMLElement | undefined {
  const same = navigables(document).filter((element) => identityOf(element) === snapshot.identity);
  return same[snapshot.ordinal] ?? same[0];
}

/**
 * After a page change made with the keys, put focus somewhere sensible once
 * the page has rendered: back on the item it was on (Back), or on the page's
 * start (`data-nav-start`, such as Play). Waits a few frames for content and
 * gives up as soon as the user does something else.
 */
function settleFocus(router: Router) {
  let lastKey = router.state.location.key;
  let cancel: (() => void) | undefined;

  return router.subscribe((state) => {
    const { key } = state.location;
    if (state.navigation.state !== 'idle' || key === lastKey) return;
    lastKey = key;
    cancel?.();
    if (!usingKeys) return;
    const snapshot = state.historyAction === NavigationType.Pop ? snapshots.get(key) : undefined;
    const deadline = performance.now() + SETTLE_MS;
    /** Focused when the page changed: it stays until the old page is gone. */
    const before = document.activeElement;
    let frame = 0;
    let found: HTMLElement | undefined;
    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', stop, true);
      window.removeEventListener('keydown', stop, true);
    };
    cancel = stop;
    window.addEventListener('pointerdown', stop, true);
    window.addEventListener('keydown', stop, true);
    const step = () => {
      const active = document.activeElement;
      // Focus already went somewhere (an autofocus, a click): leave it.
      if (active && active !== document.body && active !== before) return stop();
      // Still on the old page, or kept by an in-page change (a tab): wait.
      if (active === before && before?.isConnected && before !== document.body) {
        if (performance.now() > deadline) return stop();
        frame = requestAnimationFrame(step);
        return;
      }
      if (found?.isConnected) {
        // A frame after it appeared, so the page's own scroll reset has run.
        focusWithKeys(found);
        return stop();
      }
      const main = document.querySelector('main');
      found =
        (snapshot && find(snapshot)) ??
        (main
          ? navigables(main).find((element) => element.matches('[data-nav-start]'))
          : undefined);
      if (performance.now() > deadline) return stop();
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  });
}

/** Turns on keyboard and remote navigation. Returns a function that turns it off. */
export function installRemoteNavigation(router: Router): () => void {
  const keydown = (event: KeyboardEvent) => onKeyDown(router, event);
  const pointerdown = () => {
    usingKeys = false;
  };
  const focusin = (event: FocusEvent) => onFocusIn(router, event);
  // Capture on the window: before any page's own key handling, which skips
  // keys this handled (`defaultPrevented`).
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('pointerdown', pointerdown, true);
  document.addEventListener('focusin', focusin);
  document.addEventListener('focusout', onFocusOut);
  const unsubscribe = settleFocus(router);
  return () => {
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('pointerdown', pointerdown, true);
    document.removeEventListener('focusin', focusin);
    document.removeEventListener('focusout', onFocusOut);
    unsubscribe();
  };
}
