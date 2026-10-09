import { io } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { adminHref, liveRoomHref } from '../../lib/routes';
import { getLiveRoom } from '../../lib/server/catalog';
import { log } from '../../lib/server/log';
import { getViewer } from '../../lib/server/session';
import { initials } from '../../lib/text';
import { Footer } from './footer';
import { type NavAccount, NavigationBar, NavSentinel } from './nav-bar';
import { SkipLink } from './skip-link';

/**
 * The storefront chrome: navigation bar, <main> and footer, at least one viewport tall so a short page keeps
 * its footer at the bottom of the window. The bar and the footer depend on the session cookie and on whether
 * a drop is live, so they stream in through Suspense; their fallbacks have the same layout, and the page
 * itself stays cacheable.
 */
export function StoreShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
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

/**
 * The room of the drop that is LIVE right now, for the bar's and the footer's "Live" link (§9.18, §9.20).
 * The chrome must render while api is down, so a failed read only leaves the link out. `io()` first keeps
 * the cached drop list out of `next build`, where no api exists (SD §8.1 build rule).
 */
async function chromeLiveHref(): Promise<string | null> {
  await io();
  try {
    return liveRoomHref(await getLiveRoom());
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error }, 'cannot read the live drop for the store chrome');
    return null;
  }
}

/** The navigation bar with the viewer's account and the live room's link; the live room uses it too. */
export async function SessionNavigationBar() {
  const [account, liveHref] = await Promise.all([chromeAccount(), chromeLiveHref()]);
  return <NavigationBar account={account} liveHref={liveHref} />;
}

async function SessionFooter() {
  const [account, liveHref] = await Promise.all([chromeAccount(), chromeLiveHref()]);
  return <Footer account={account} liveHref={liveHref} />;
}
