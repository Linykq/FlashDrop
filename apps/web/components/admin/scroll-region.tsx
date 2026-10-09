'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * A region that scrolls sideways when its content is wider than the screen (design system §9.22): data tables
 * and charts are exempt from reflow (WCAG 1.4.10), so they scroll instead. Only while it actually overflows
 * is it a named region in the tab order, so a keyboard user can scroll it with the arrow keys (axe
 * `scrollable-region-focusable`) and hears what it is when focus lands on it. When everything fits it is a
 * plain box: no pointless tab stop, and no second landmark repeating the heading the table sits under. It also
 * says so in `data-overflows`, for styles that only apply while it does (a table that must scroll).
 */
export function ScrollRegion({
  labelledBy,
  className,
  children,
}: {
  labelledBy: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the name is set only together with role="region".
    <div
      ref={ref}
      role={overflows ? 'region' : undefined}
      aria-labelledby={overflows ? labelledBy : undefined}
      tabIndex={overflows ? 0 : undefined}
      data-overflows={overflows || undefined}
      className={className}
    >
      {children}
    </div>
  );
}
