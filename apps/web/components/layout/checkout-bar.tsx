import type { ReactNode } from 'react';
import { ScrollEdge } from './scroll-edge';

/**
 * The reduced navigation bar of checkout (design-system §9.18): the wordmark as plain text, so nothing pulls
 * the buyer out of the purchase by accident, and on the right the way out. Like the full bar it is
 * `material-bar`, so everything on it is `label` (§2.5).
 */
export function CheckoutBar({ action }: { action: ReactNode }) {
  return (
    <header
      data-nav-bar
      className="material-bar sticky top-0 z-(--z-nav) border-transparent border-b pt-[env(safe-area-inset-top)] transition-colors duration-200 ease-standard data-scrolled:border-separator"
    >
      <ScrollEdge />
      <div className="page-wide flex h-(--nav-height) items-center justify-between gap-8">
        <span className="text-headline">FlashDrop</span>
        {action}
      </div>
    </header>
  );
}
