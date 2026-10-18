import { Button, buttonVariants } from '@kiro/ui';
import { TriangleAlert } from 'lucide-react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

/** Fallback UI for render or navigation errors anywhere in the app shell. */
export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const detail = import.meta.env.DEV && error instanceof Error ? error.message : null;

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-ink-950 px-8 text-center text-ink-100">
      <TriangleAlert aria-hidden className="size-8 text-accent-strong" />
      <h1 className="text-xl font-semibold text-ink-50">
        {notFound ? 'This page does not exist' : 'Something went wrong'}
      </h1>
      {detail && <pre className="max-w-xl text-xs whitespace-pre-wrap text-ink-400">{detail}</pre>}
      <div className="mt-2 flex gap-3">
        <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
          Back to Discover
        </Link>
        {!notFound && <Button onClick={() => window.location.reload()}>Reload</Button>}
      </div>
    </div>
  );
}
