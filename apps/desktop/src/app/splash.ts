/**
 * The splash in index.html stays at least this long after the page starts
 * loading, so a fast start shows the mascot rather than a flicker. Its own CSS
 * fades it out after 10 s if the app never takes over.
 */
export const MIN_SPLASH_MS = 500;
/** Removes the splash if its fade never reports finishing (a hidden window). */
const LEAVE_FALLBACK_MS = 600;
/** Stops waiting for a paint where frames don't run (a hidden window). */
const PAINT_FALLBACK_MS = 100;

/** The part of the app router the hand-off needs. */
export interface StartupRouter {
  readonly state: { initialized: boolean };
  subscribe(listener: (state: { initialized: boolean }) => void): () => void;
}

/** Resolves once the router has loaded its first route, lazy routes included. */
export function whenRouterReady(router: StartupRouter): Promise<void> {
  if (router.state.initialized) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (!state.initialized) return;
      unsubscribe();
      resolve();
    });
  });
}

/** How much longer the splash stays, `elapsed` ms after the page started loading. */
export function remainingSplashMs(elapsed: number): number {
  return Math.max(0, MIN_SPLASH_MS - elapsed);
}

/**
 * Fades the splash out and removes it. From the first frame of the fade it
 * ignores the pointer and leaves the accessibility tree. Safe to call twice.
 */
export function hideSplash() {
  const splash = document.getElementById('kiro-splash');
  if (!splash || splash.hasAttribute('data-leaving')) return;

  splash.setAttribute('data-leaving', '');
  splash.setAttribute('aria-hidden', 'true');
  splash.inert = true;

  const remove = () => splash.remove();
  splash.addEventListener('animationend', (event) => {
    if (event.target === splash) remove();
  });
  window.setTimeout(remove, LEAVE_FALLBACK_MS);
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Resolves after `ms` milliseconds. */
export const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Resolves once the next frame has painted (two frames: the first runs before
 * paint), or soon after where frames don't run.
 */
export function afterNextPaint(): Promise<void> {
  return Promise.race([nextFrame().then(nextFrame), delay(PAINT_FALLBACK_MS)]);
}
