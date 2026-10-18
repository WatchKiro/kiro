import { useEffect, useRef, useState } from 'react';
import { NavigationType, Outlet, useLocation, useNavigationType } from 'react-router';

import { Header } from '@/components/header';
import { Sidebar } from '@/components/sidebar';
import { useRouteHandle } from '@/hooks/use-route-handle';

/**
 * The app shell. The header floats over the top of the scrolling content, so
 * pages with artwork (Discover, a title) run it to the top of the window; it
 * turns solid once content scrolls beneath it.
 */
export function AppLayout() {
  const mainRef = useRef<HTMLElement>(null);
  const { pathname, search } = useLocation();
  const navigationType = useNavigationType();
  const { title } = useRouteHandle();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    document.title = title ? `${title} · Kiro` : 'Kiro';
  }, [title]);

  // `main` scrolls, not the window, so new pages would otherwise open
  // mid-scroll. A new query string scrolls up too when it was pushed (a new
  // catalogue), but not when replaced in place (a tab or episode on a title).
  const lastPathname = useRef(pathname);
  useEffect(() => {
    const newPage = lastPathname.current !== pathname;
    lastPathname.current = pathname;
    if (newPage || navigationType === NavigationType.Push) mainRef.current?.scrollTo(0, 0);
  }, [pathname, search, navigationType]);

  return (
    <div className="flex h-dvh overflow-hidden bg-ink-950 text-ink-100">
      <Sidebar />
      <main
        ref={mainRef}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 8)}
        className="relative min-w-0 flex-1 overflow-y-auto"
      >
        <Header solid={scrolled} />
        <Outlet />
      </main>
    </div>
  );
}
