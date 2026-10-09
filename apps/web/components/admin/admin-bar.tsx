import Link from 'next/link';
import { Suspense } from 'react';
import { AccountMenu } from '../layout/account-menu';
import type { NavAccount } from '../layout/nav-bar';
import { ScrollEdge } from '../layout/scroll-edge';
import { CompactTitle } from './compact-title';

/**
 * The admin area's navigation bar (design system §9.18, §10.7): the same translucent `material-bar` as the
 * storefront's, in `page-full`, with the product name instead of storefront links (the sidebar navigates)
 * and the account menu on the right. When the page's large title scrolls under it, a compact copy fades in
 * (§9.19): centred on a phone, after the name from 735 px. Everything on the bar is `label` (§2.5).
 */
export function AdminBar({ account }: { account: NavAccount | undefined }) {
  return (
    <header
      data-nav-bar
      className="material-bar sticky top-0 z-(--z-nav) border-transparent border-b pt-[env(safe-area-inset-top)] transition-colors duration-200 ease-standard data-scrolled:border-separator"
    >
      <ScrollEdge />
      <div className="page-full relative flex h-(--nav-height) items-center gap-4">
        <p className="flex shrink-0 items-baseline gap-1.5 text-headline">
          <Link href="/" className="inline-flex h-11 items-center text-label">
            FlashDrop
          </Link>
          <span className="font-normal text-label/80 max-sm:hidden">Admin</span>
        </p>
        <div className="flex min-w-0 flex-1 items-center max-sm:pointer-events-none max-sm:absolute max-sm:inset-x-28 max-sm:justify-center">
          <Suspense fallback={null}>
            <CompactTitle />
          </Suspense>
        </div>
        {account === undefined ? (
          // Holds the account's place while the session streams in, so nothing moves when it arrives.
          <span aria-hidden="true" className="-mx-2 ml-auto size-11 shrink-0" />
        ) : (
          <div className="ml-auto shrink-0">
            <AccountMenu account={account} />
          </div>
        )}
      </div>
    </header>
  );
}
