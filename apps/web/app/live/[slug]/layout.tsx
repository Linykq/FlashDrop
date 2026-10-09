import { type ReactNode, Suspense } from 'react';
import { NavigationBar, NavSentinel } from '../../../components/layout/nav-bar';
import { SkipLink } from '../../../components/layout/skip-link';
import { SessionNavigationBar } from '../../../components/layout/store-shell';

/**
 * The live room's chrome (design-system §8.1, §10.3): always dark, like a theatre. The dark tokens are scoped
 * to this subtree (`data-theme="dark"`), navigation bar included, and `data-page="live"` paints the root and
 * its scrollbar black (base.css) rather than a wrapper, so overscroll matches. No footer.
 */
export default function LiveLayout({ children }: { children: ReactNode }) {
  return (
    <div data-theme="dark" data-page="live" className="flex min-h-dvh flex-col text-label">
      <SkipLink />
      <Suspense fallback={<NavigationBar account={undefined} />}>
        <SessionNavigationBar />
      </Suspense>
      <main id="main" className="flex-1">
        <NavSentinel />
        {children}
      </main>
    </div>
  );
}
