'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx';

/** Changes closer together than this (over 4 a second) swap plainly: motion would only blur them (§6.4). */
const MIN_GAP_MS = 250;

/**
 * LiveStock's primary line, which eases in from 4 px below when the stock changes (design-system §6.4, the
 * stock number), only with full motion, and never during a burst. Nothing moves on first render.
 */
export function StockFigure({ text }: { text: string }) {
  const last = useRef({ text, at: Number.NEGATIVE_INFINITY });
  const [animate, setAnimate] = useState(false);

  // Before paint, so the new text never shows unanimated first.
  useLayoutEffect(() => {
    if (last.current.text === text) return;
    const now = performance.now();
    setAnimate(now - last.current.at >= MIN_GAP_MS);
    last.current = { text, at: now };
  }, [text]);

  return (
    <span key={text} className={cx('inline-block', animate && 'motion-safe:animate-number-in')}>
      {text}
    </span>
  );
}
