'use client';

import { useEffect, useRef } from 'react';

/**
 * Shows the navigation bar's bottom hairline only while content is scrolled beneath the bar (§9.18). It watches
 * the `NavSentinel` at the top of <main>, shrinking the viewport by the bar's height, so the hairline appears
 * as soon as the first pixel of content passes under the bar. Pages without a sentinel never show it.
 */
export function ScrollEdge() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const header = ref.current?.closest('header');
    const sentinel = document.querySelector('[data-nav-sentinel]');
    if (!header || !sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => header.toggleAttribute('data-scrolled', entry !== undefined && !entry.isIntersecting),
      { rootMargin: `-${header.offsetHeight}px 0px 0px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return <span ref={ref} hidden />;
}
