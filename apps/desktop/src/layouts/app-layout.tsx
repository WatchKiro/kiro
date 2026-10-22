import { useEffect, useRef, useState } from 'react';
import { NavigationType, Outlet, useLocation, useNavigationType } from 'react-router';

import { Header } from '@/components/header';
import { Sidebar } from '@/components/sidebar';
import { FirstRunGate } from '@/features/onboarding/first-run';
import { useSetupStore } from '@/features/onboarding/setup-store';
import { ProfilePicker } from '@/features/profiles/profile-picker';
import { useProfilesStore } from '@/features/profiles/profiles-store';
import { useRouteHandle } from '@/hooks/use-route-handle';
import { isNativeRuntime } from '@/services/native';

/**
 * The app shell. The header floats over the top of the scrolling content, so
 * pages with artwork (Discover, a title) run it to the top of the window; it
 * turns solid once content scrolls beneath it.
 *
 * It opens on "Who’s watching?" when there's a profile to choose (more than
 * one, or a PIN to enter), before any page reads a library; switching
 * profiles later renders the page again for the new one. Then the profile's
 * first-run setup, if it has something to set up.
 */
export function AppLayout() {
  const native = isNativeRuntime();
  const status = useProfilesStore((state) => state.status);
  const picker = useProfilesStore((state) => state.picker);
  const active = useProfilesStore((state) => state.overview?.active);
  const loadProfiles = useProfilesStore((state) => state.load);
  const setupOpen = useSetupStore((state) => state.open !== null);

  useEffect(() => {
    if (native) void loadProfiles();
  }, [native, loadProfiles]);

  // A local read: the splash stays over this until it's done.
  if (native && (status === 'idle' || status === 'loading')) {
    return <div className="h-dvh bg-ink-950" />;
  }
  // At launch the picker stands in for the app, so nothing loads for a
  // profile that may not be the one chosen.
  if (picker === 'launch') return <ProfilePicker />;
  return (
    <>
      <Shell key={active} covered={picker === 'switch' || setupOpen} />
      {picker === 'switch' ? <ProfilePicker /> : <FirstRunGate key={active} />}
    </>
  );
}

/** The sidebar and the page. `covered`: under the picker, out of reach. */
function Shell({ covered }: { covered: boolean }) {
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
    <div inert={covered} className="flex h-dvh overflow-hidden bg-ink-950 text-ink-100">
      <Sidebar />
      <main
        ref={mainRef}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 8)}
        // Things scrolled into view (keyboard and remote focus) stop below the
        // header that floats over the page, with room for their row's title.
        className="relative min-w-0 flex-1 scroll-pt-28 scroll-pb-6 overflow-y-auto"
      >
        <Header solid={scrolled} />
        <Outlet />
      </main>
    </div>
  );
}
