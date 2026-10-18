import { cx } from '@kiro/utils';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** How far the edges fade where more of the strip is hidden. */
const FADE = '2.5rem';

/**
 * One line of controls that scrolls sideways when it doesn't fit, instead of
 * wrapping onto ragged extra lines: no scrollbar, the edges fade where more is
 * hidden, and a mouse wheel scrolls it too (trackpads already can). Keyboard
 * focus scrolls the focused item into view on its own.
 */
export function ScrollStrip({
  label,
  className,
  children,
}: {
  /** Names the strip for assistive tech (it is a `nav`). */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ start: false, end: false });

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setHidden((current) =>
        current.start === start && current.end === end ? current : { start, end },
      );
    };
    // A vertical wheel scrolls the strip until it reaches an end, then the
    // page as usual.
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const max = element.scrollWidth - element.clientWidth;
      const next = Math.min(max, Math.max(0, element.scrollLeft + event.deltaY));
      if (max <= 0 || next === element.scrollLeft) return;
      event.preventDefault();
      element.scrollLeft = next;
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: false });
    const resize = new ResizeObserver(update);
    resize.observe(element);
    if (content.current) resize.observe(content.current);
    return () => {
      element.removeEventListener('scroll', update);
      element.removeEventListener('wheel', onWheel);
      resize.disconnect();
    };
  }, []);

  const mask = `linear-gradient(to right, ${hidden.start ? 'transparent' : 'black'}, black ${FADE}, black calc(100% - ${FADE}), ${hidden.end ? 'transparent' : 'black'})`;
  return (
    <nav
      ref={scroller}
      aria-label={label}
      data-nav-group
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      // Padding keeps focus rings inside the scroller, which clips them.
      className={cx('[scrollbar-width:none] overflow-x-auto overscroll-x-contain', className)}
    >
      <div ref={content} className="flex w-max items-center gap-1.5 p-1.5">
        {children}
      </div>
    </nav>
  );
}
