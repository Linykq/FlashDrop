'use client';

import { useState } from 'react';
import type { CheckoutHold } from '../../lib/checkout-hold';
import { useServerTime } from '../../lib/clock';
import { holdClock, holdState, showsExtensionRow } from '../../lib/hold';
import { useHoldCountdownHidden } from '../../lib/hold-visibility';
import { ExtensionRow } from './extension-row';
import type { ExtendOrigin, Extension } from './use-hold-extension';

type ExtensionOfferProps = {
  hold: CheckoutHold;
  extension: Extension;
  onExtend: (origin: ExtendOrigin) => void;
};

/**
 * The hold card's extension row again, just above Pay (design-system §10.4, WCAG 2.2.1): a buyer filling in
 * the form on a phone is about 1500 px below the card when the offer comes. It shows while the card's
 * countdown is out of view, from the same state as the card's row, and once shown it stays until the hold
 * ends, so scrolling never takes away a row that holds focus or the result of its press.
 */
export function ExtensionOffer({ hold, extension, onExtend }: ExtensionOfferProps) {
  const now = useServerTime(hold.serverNow);
  const state = holdState(now, holdClock(hold.createdAt, hold.expiresAt));
  const countdownHidden = useHoldCountdownHidden();
  const shows = showsExtensionRow(state, hold.extensions, extension.kind !== 'offered');
  const [pinned, setPinned] = useState(false);
  // Derived from this render: pinned the first time the row shows here (React's "previous render" pattern).
  if (shows && countdownHidden && !pinned) setPinned(true);
  if (!shows || !(countdownHidden || pinned)) return null;

  return (
    <div className="mt-6 animate-fade-in rounded-lg bg-surface px-4 py-3 elevation-1 sm:px-5">
      <ExtensionRow extension={extension} onExtend={onExtend} />
    </div>
  );
}
