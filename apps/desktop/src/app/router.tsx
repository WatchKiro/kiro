import { createBrowserRouter } from 'react-router';

import type { RouteHandle } from '@/app/navigation';
import { RouteError } from '@/components/route-error';
import { DiscoverPage } from '@/features/discovery/discover-page';
import { AppLayout } from '@/layouts/app-layout';

// Dev only: with VITE_KIRO_SPIKE_AUTOPLAY set, start on the player page.
if (
  import.meta.env.DEV &&
  import.meta.env.VITE_KIRO_SPIKE_AUTOPLAY &&
  window.location.pathname === '/'
) {
  window.history.replaceState(null, '', '/player');
}

/**
 * Discover is the start screen and is bundled eagerly; every other section is
 * code-split so the initial bundle stays small as features grow.
 */
export const router = createBrowserRouter([
  {
    // Full-window native player, outside the app shell so the video
    // (drawn beneath the webview) can fill the window.
    path: '/player',
    ErrorBoundary: RouteError,
    lazy: async () => ({
      Component: (await import('@/features/playback/player-page')).PlayerPage,
    }),
  },
  {
    path: '/',
    Component: AppLayout,
    ErrorBoundary: RouteError,
    children: [
      { index: true, Component: DiscoverPage, handle: { title: 'Discover' } satisfies RouteHandle },
      {
        path: 'movies',
        handle: { title: 'Movies' } satisfies RouteHandle,
        lazy: async () => ({
          Component: (await import('@/features/discovery/browse-pages')).MoviesPage,
        }),
      },
      {
        path: 'tv',
        handle: { title: 'TV Shows' } satisfies RouteHandle,
        lazy: async () => ({
          Component: (await import('@/features/discovery/browse-pages')).TvShowsPage,
        }),
      },
      {
        // Other content types an addon lists catalogues of (`/browse/anime`).
        path: 'browse/:type',
        handle: { title: 'Browse' } satisfies RouteHandle,
        lazy: async () => ({
          Component: (await import('@/features/discovery/browse-pages')).TypeBrowsePage,
        }),
      },
      {
        path: 'search',
        handle: { title: 'Search' } satisfies RouteHandle,
        lazy: async () => ({
          Component: (await import('@/features/search/search-page')).SearchPage,
        }),
      },
      {
        path: 'title/:type/:id',
        handle: { title: 'Details', back: true } satisfies RouteHandle,
        lazy: async () => ({
          Component: (await import('@/features/title/title-page')).TitlePage,
        }),
      },
      {
        path: 'library',
        handle: { title: 'Library' } satisfies RouteHandle,
        lazy: async () => ({
          Component: (await import('@/features/library/library-page')).LibraryPage,
        }),
      },
      {
        path: 'addons',
        handle: { title: 'Addons' } satisfies RouteHandle,
        lazy: async () => ({
          Component: (await import('@/features/addons/addons-page')).AddonsPage,
        }),
      },
      {
        path: 'settings',
        handle: { title: 'Settings' } satisfies RouteHandle,
        lazy: async () => ({
          Component: (await import('@/features/settings/settings-page')).SettingsPage,
        }),
      },
    ],
  },
]);
