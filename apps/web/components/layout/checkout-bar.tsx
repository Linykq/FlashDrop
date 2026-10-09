import type { ReactNode } from 'react';
import { ScrollEdge } from './scroll-edge';

/**
 * The reduced navigation bar of checkout (design-system §9.18): the wordmark as plain text, so nothing pulls
 * the buyer out of the purchase by accident, and on the right the way out. `status` follows the wordmark: the
 * compact countdown, while the hold card's is out of view (§9.19). A phone's bar has no room for the wordmark,
 * the countdown and "Leave checkout" at once, so there the countdown takes the wordmark's place. Like the full
 * bar it is `material-bar`, so everything on it is `label` (§2.5).
 */
export function CheckoutBar({ status, action }: { status: ReactNode; action: ReactNode }) {
  return (
    <header
      data-nav-bar
      className="group/bar material-bar sticky top-0 z-(--z-nav) border-transparent border-b pt-[env(safe-area-inset-top)] transition-colors duration-200 ease-standard data-scrolled:border-separator"
    >
      <ScrollEdge />
      <div className="page-wide flex h-(--nav-height) items-center justify-between gap-8">
        <div className="flex min-w-0 items-center gap-4">
          <span className="text-headline max-sm:group-has-[[data-hold-timer]]/bar:hidden">FlashDrop</span>
          {status}
        </div>
        {action}
      </div>
    </header>
  );
}
