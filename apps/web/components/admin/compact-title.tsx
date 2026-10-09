'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * The large title's compact copy in the admin bar (design system §9.19): once the page's `h1` (marked
 * `data-large-title`) has scrolled under the bar, its text fades in, in `text-headline`. The copy is
 * `aria-hidden`: the `h1` stays the page's heading. It re-reads the title after every navigation, and while
 * the page streams (the title can arrive after this island mounts).
 */
export function CompactTitle() {
  const pathname = usePathname();
  const [title, setTitle] = useState<string | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const bar = document.querySelector<HTMLElement>('[data-nav-bar]');
    let observer: IntersectionObserver | undefined;
    let watched: Element | null = null;

    const watch = () => {
      const heading = document.querySelector('[data-large-title]');
      if (heading === watched) return;
      observer?.disconnect();
      watched = heading;
      setTitle(heading?.textContent?.trim() || null);
      setShown(false);
      if (!heading || !bar) return;
      const barHeight = bar.offsetHeight;
      // Out of view above the bar, not below the fold: only a title the admin scrolled past is repeated.
      observer = new IntersectionObserver(
        ([entry]) =>
          setShown(
            entry !== undefined && !entry.isIntersecting && entry.boundingClientRect.bottom <= barHeight,
          ),
        { rootMargin: `-${barHeight}px 0px 0px 0px` },
      );
      observer.observe(heading);
    };

    watch();
    // Streamed content replaces the Suspense fallback after mount; a title arriving then is picked up here.
    const mutations = new MutationObserver(watch);
    const main = document.getElementById('main');
    if (main) mutations.observe(main, { childList: true, subtree: true });
    return () => {
      mutations.disconnect();
      observer?.disconnect();
    };
  }, [pathname]);

  return (
    <span
      aria-hidden="true"
      data-shown={shown || undefined}
      className="pointer-events-none flex min-w-0 items-center gap-4 opacity-0 transition-opacity duration-200 ease-standard data-shown:opacity-100"
    >
      <span className="h-4 w-px shrink-0 bg-separator max-sm:hidden" />
      <span className="min-w-0 truncate text-headline text-label">{title}</span>
    </span>
  );
}
