import Link from 'next/link';
import { Suspense } from 'react';
import { cx } from '../../lib/cx';
import { AccountMenu } from './account-menu';
import { type NavLinkItem, NavLinkList, navLinkClass } from './nav-link-list';
import { CurrentNavLinks } from './nav-links';
import { ScrollEdge } from './scroll-edge';
import { SignInLink } from './sign-in-link';

/** The signed-in viewer as the chrome shows them. */
export type NavAccount = {
  name: string;
  initials: string;
  /** The admin area for admins once it exists, otherwise `null`. */
  adminHref: string | null;
};

type NavigationBarProps = {
  /** The signed-in viewer, `null` for "Sign in", or `undefined` while the session is still being read. */
  account: NavAccount | null | undefined;
  /** The room of the drop that is LIVE right now; the "Live" link exists only while one is. */
  liveHref?: string | null;
  /** `full` in admin, `wide` everywhere else. */
  width?: 'wide' | 'full';
  /** Off only where the bar is shown as a specimen rather than as the page's bar. */
  sticky?: boolean;
};

/**
 * The translucent bar over every storefront page (§9.18). Everything on it is `label`, because the material
 * can sit over any content. There is no navigation menu, since the phone bar shows every link; the avatar
 * opens the account menu.
 */
export function NavigationBar({
  account,
  liveHref = null,
  width = 'wide',
  sticky = true,
}: NavigationBarProps) {
  const links: NavLinkItem[] = [{ href: '/', label: 'Drops' }];
  if (liveHref) links.push({ href: liveHref, label: 'Live', live: true });

  return (
    <header
      data-nav-bar
      className={cx(
        // The transparent border keeps the bar's shape in forced-colours mode, which paints every border.
        'material-bar z-(--z-nav) border-transparent border-b pt-[env(safe-area-inset-top)]',
        'transition-colors duration-200 ease-standard data-scrolled:border-separator',
        sticky && 'sticky top-0',
      )}
    >
      {sticky && <ScrollEdge />}
      <div
        className={cx(
          'flex h-(--nav-height) items-center gap-8',
          width === 'full' ? 'page-full' : 'page-wide',
        )}
      >
        <Link href="/" className="inline-flex h-11 items-center text-headline text-label">
          FlashDrop
        </Link>
        <nav aria-label="Main" className="max-sm:ml-auto">
          <Suspense fallback={<NavLinkList links={links} current={null} />}>
            <CurrentNavLinks links={links} />
          </Suspense>
        </nav>
        <div className="flex items-center gap-6 sm:ml-auto">
          {account?.adminHref && (
            <Link href={account.adminHref} className={cx(navLinkClass, 'max-sm:hidden')}>
              Admin
            </Link>
          )}
          {account === undefined ? (
            // Holds the account's place while the session streams in, so nothing moves when it arrives.
            <span aria-hidden="true" className="-mx-2 size-11" />
          ) : account ? (
            <AccountMenu account={account} />
          ) : (
            <Suspense
              fallback={
                <Link href="/login" className={navLinkClass}>
                  Sign in
                </Link>
              }
            >
              <SignInLink className={navLinkClass} />
            </Suspense>
          )}
        </div>
      </div>
    </header>
  );
}

/** The marker the bar's hairline watches (§9.18): render it as the first child of <main>. */
export function NavSentinel() {
  return <div data-nav-sentinel aria-hidden="true" />;
}
