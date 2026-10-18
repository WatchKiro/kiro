import { useEffect } from 'react';
import type { createBrowserRouter } from 'react-router';

import { useAppInfo } from '@/hooks/use-app-info';

/**
 * CI's check of an installed build: started with `KIRO_SMOKE_TEST_URL`, the
 * app opens the player, which plays that URL and pauses
 * (`scripts/playback-smoke.mjs --app`). Renders nothing.
 */
export function SmokeTestStart({ router }: { router: ReturnType<typeof createBrowserRouter> }) {
  const appInfo = useAppInfo();
  const url = appInfo.status === 'ready' ? appInfo.info.smokeTestUrl : null;
  useEffect(() => {
    if (url && router.state.location.pathname !== '/player') {
      void router.navigate('/player', { replace: true });
    }
  }, [url, router]);
  return null;
}
