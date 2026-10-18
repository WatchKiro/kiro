import { useMatches } from 'react-router';

import type { RouteHandle } from '@/app/navigation';

/** The deepest matched route's handle (its title and header options). */
export function useRouteHandle(): Partial<RouteHandle> {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i]?.handle as Partial<RouteHandle> | undefined;
    if (handle?.title) return handle;
  }
  return {};
}
