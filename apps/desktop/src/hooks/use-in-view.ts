import { useEffect, useState } from 'react';

interface InViewOptions {
  /** Grows the viewport for the test, e.g. `100% 0px` for "within a screen". */
  rootMargin?: string;
  /** Stay `true` once the element has been in view, and stop observing. */
  once?: boolean;
}

/**
 * Whether an element is in (or, with `rootMargin`, near) the viewport. Pass
 * the returned callback as the element's `ref`; it works for elements that
 * mount later or remount.
 */
export function useInView<T extends Element>({
  rootMargin = '100% 0px',
  once = false,
}: InViewOptions = {}) {
  const [element, setElement] = useState<T | null>(null);
  const [inView, setInView] = useState(false);
  const done = once && inView;

  useEffect(() => {
    if (!element || done) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const latest = entries.at(-1);
        if (latest) setInView(latest.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, done, rootMargin]);

  return [setElement, inView] as const;
}
