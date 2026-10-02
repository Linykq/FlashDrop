'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * After a client-side navigation the skip link is the first tab stop again (§13.2), as after a full load:
 * otherwise focus stays on the link that navigated (or falls to <body> where that link was removed), and
 * the next Tab continues from there, deep in the new page. Focusing this mark at the top of <body> and
 * releasing it at once moves the browser's sequential-navigation starting point here without putting focus
 * anywhere a screen reader would announce; Next's route announcer still reads the new title.
 */
export function RouteFocusReset() {
  const pathname = usePathname();
  const mark = useRef<HTMLDivElement>(null);
  const shown = useRef(pathname);

  useEffect(() => {
    if (shown.current === pathname) return;
    shown.current = pathname;
    const element = mark.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.blur();
  }, [pathname]);

  return <div ref={mark} tabIndex={-1} aria-hidden="true" className="outline-none" />;
}
