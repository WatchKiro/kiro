import { Badge, Button } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { ChevronLeft } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';

import { SearchBox } from '@/features/search/search-box';
import { useAppInfo } from '@/hooks/use-app-info';
import { useRouteHandle } from '@/hooks/use-route-handle';
import { isPreviewBackend } from '@/services/native';

/**
 * The floating header (4rem tall): Back where the route asks for it, search,
 * and the runtime badge. Pages leave it clear unless artwork runs under it.
 */
export function Header({ solid }: { solid: boolean }) {
  const { back } = useRouteHandle();
  const appInfo = useAppInfo();

  return (
    <header
      // Over the page's top: arrows reach it after whatever is beneath it.
      data-nav-fallback
      className={cx(
        // The border is always there (transparent while floating) so scrolling
        // only fades its colour: adding it on scroll drew it in Tailwind's
        // default `currentColor` (near-white) for the length of the transition.
        // `bg-origin-border` sizes the floating gradient to include that border;
        // otherwise it repeats into the 1px strip and draws a dark line.
        'sticky top-0 z-30 -mb-16 flex h-16 items-center gap-6 border-b bg-origin-border px-8 transition-[background-color,border-color,backdrop-filter] duration-300',
        solid
          ? 'border-white/[0.06] bg-ink-950/80 backdrop-blur-xl'
          : 'border-transparent bg-linear-to-b from-ink-950/60 to-transparent',
      )}
    >
      <div className="flex min-w-28 items-center">{back && <BackButton />}</div>

      <SearchBox />

      <div className="flex min-w-28 justify-end">
        {isPreviewBackend() ? (
          <Badge
            tone="accent"
            title="Native commands are answered by the development preview backend"
          >
            Preview data
          </Badge>
        ) : (
          appInfo.status === 'unavailable' &&
          appInfo.reason === 'browser' && (
            <Badge tone="accent" title="Running outside Tauri — native features are unavailable">
              Browser preview
            </Badge>
          )
        )}
      </div>
    </header>
  );
}

function BackButton() {
  const navigate = useNavigate();
  // `default` is the first entry of this session: there is nothing to go back to.
  const canGoBack = useLocation().key !== 'default';
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 text-ink-100"
      onClick={() => void (canGoBack ? navigate(-1) : navigate('/'))}
    >
      <ChevronLeft aria-hidden className="size-4" />
      Back
    </Button>
  );
}
