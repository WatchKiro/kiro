import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_SPLASH_MS,
  remainingSplashMs,
  whenRouterReady,
  type StartupRouter,
} from '@/app/splash';

/** A router that loads its first route when `finish` is called. */
function fakeRouter(initialized = false) {
  const listeners = new Set<(state: { initialized: boolean }) => void>();
  let state = { initialized };
  const router: StartupRouter & { finish(): void; listeners: typeof listeners } = {
    get state() {
      return state;
    },
    listeners,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    finish() {
      state = { initialized: true };
      for (const listener of [...listeners]) listener(state);
    },
  };
  return router;
}

describe('whenRouterReady', () => {
  it('resolves at once when the first route is already loaded', async () => {
    const router = fakeRouter(true);
    await whenRouterReady(router);
    assert.equal(router.listeners.size, 0);
  });

  it('waits for a lazy first route, then unsubscribes', async () => {
    const router = fakeRouter();
    let ready = false;
    const waiting = whenRouterReady(router).then(() => (ready = true));

    for (const listener of router.listeners) listener({ initialized: false });
    await Promise.resolve();
    assert.equal(ready, false);

    router.finish();
    await waiting;
    assert.equal(ready, true);
    assert.equal(router.listeners.size, 0);
  });
});

describe('remainingSplashMs', () => {
  it('keeps the splash up for the minimum time', () => {
    assert.equal(remainingSplashMs(0), MIN_SPLASH_MS);
    assert.equal(remainingSplashMs(MIN_SPLASH_MS - 120), 120);
  });

  it('never waits once the minimum has passed', () => {
    assert.equal(remainingSplashMs(MIN_SPLASH_MS), 0);
    assert.equal(remainingSplashMs(5000), 0);
  });
});
