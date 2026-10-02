'use client';

import { useEffect, useRef } from 'react';

export type Politeness = 'polite' | 'assertive';

type Announcement = { text: string; politeness: Politeness };

const listeners = new Set<(announcement: Announcement) => void>();

/**
 * Reads `text` to screen-reader users through the app-wide live regions (design-system §13.3). Callers own the
 * policy: what is worth announcing, and at most one announcement per 3 s from any one source.
 */
export function announce(text: string, politeness: Politeness = 'polite'): void {
  for (const listener of listeners) listener({ text, politeness });
}

/**
 * Two visually hidden regions that are always in the DOM, because a region inserted together with its text is
 * not reliably announced. Their text is written directly, outside React: clearing it and setting it again on the
 * next frame makes a repeated message read again.
 */
export function Announcer() {
  const polite = useRef<HTMLDivElement>(null);
  const assertive = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const listener = ({ text, politeness }: Announcement) => {
      const region = politeness === 'polite' ? polite.current : assertive.current;
      if (!region) return;
      region.textContent = '';
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        region.textContent = text;
      });
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <div ref={polite} role="status" className="sr-only" />
      <div ref={assertive} role="alert" className="sr-only" />
    </>
  );
}
