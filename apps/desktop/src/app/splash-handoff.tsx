import { useEffect } from 'react';

import {
  afterNextPaint,
  delay,
  hideSplash,
  remainingSplashMs,
  whenRouterReady,
  type StartupRouter,
} from '@/app/splash';

/**
 * Hands over from the splash once the first screen has rendered. Render it
 * beside the router: its effect runs after React commits that screen.
 */
export function SplashHandoff({ router }: { router: StartupRouter }) {
  useEffect(() => {
    void (async () => {
      await whenRouterReady(router);
      // The first screen is painted beneath before the fade starts.
      await afterNextPaint();
      await delay(remainingSplashMs(performance.now()));
      hideSplash();
    })();
  }, [router]);

  return null;
}
