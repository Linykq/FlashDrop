import { unstable_rethrow } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { adminHref } from '../../lib/routes';
import { log } from '../../lib/server/log';
import { getViewer } from '../../lib/server/session';
import { initials } from '../../lib/text';
import { Footer } from './footer';
import { type NavAccount, NavigationBar, NavSentinel } from './nav-bar';

/**
 * The storefront chrome: navigation bar, <main> and footer, at least one viewport tall so a short page keeps
 * its footer at the bottom of the window. The bar and the footer depend on the session cookie, so they
 * stream in through Suspense; their fallbacks have the same layout, and the page itself stays cacheable.
 */
export function StoreShell({ children }: { children: ReactNode }) {
  // TODO(M5): pass `liveHref` (the LIVE drop's room, from liveRoomHref) to the bar and the footer.
  return (
    <div className="flex min-h-dvh flex-col">
      <Suspense fallback={<NavigationBar account={undefined} />}>
        <SessionNavigationBar />
      </Suspense>
      <main id="main" className="flex-1">
        <NavSentinel />
        {children}
      </main>
      <Suspense fallback={<Footer account={null} />}>
        <SessionFooter />
      </Suspense>
    </div>
  );
}

/**
 * The viewer for the chrome. A session that cannot be read (a misconfigured SESSION_SECRET) is logged and
 * shown as signed out, so the store stays usable; pages that act on the session read it themselves.
 */
async function chromeAccount(): Promise<NavAccount | null> {
  try {
    const viewer = await getViewer();
    return (
      viewer && { name: viewer.name, initials: initials(viewer.name), adminHref: adminHref(viewer.role) }
    );
  } catch (error) {
    unstable_rethrow(error);
    log().error({ err: error }, 'cannot read the session for the store chrome');
    return null;
  }
}

async function SessionNavigationBar() {
  return <NavigationBar account={await chromeAccount()} />;
}

async function SessionFooter() {
  return <Footer account={await chromeAccount()} />;
}
