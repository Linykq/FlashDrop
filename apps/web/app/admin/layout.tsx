import { ListingJobListResponse } from '@flashdrop/contracts';
import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { AdminBar } from '../../components/admin/admin-bar';
import { AdminSidebar, CurrentAdminSidebar } from '../../components/admin/admin-sidebar';
import { isToReview } from '../../components/admin/listing-list';
import type { NavAccount } from '../../components/layout/nav-bar';
import { NavSentinel } from '../../components/layout/nav-bar';
import { SkipLink } from '../../components/layout/skip-link';
import { adminHref } from '../../lib/routes';
import { log } from '../../lib/server/log';
import { getViewer } from '../../lib/server/session';
import { initials } from '../../lib/text';
import { adminRead } from './_lib/api';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The admin shell (design system §8.1, §10.7): its own bar in `page-full`, the sidebar, no footer, on the
 * grouped `canvas`. proxy.ts admits only an admin's session here (SD §11), and api checks the role again on
 * every read and write, so a session that lost the role still sees nothing.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div data-page="grouped" className="flex min-h-dvh flex-col">
      <SkipLink />
      <Suspense fallback={<AdminBar account={undefined} />}>
        <SessionAdminBar />
      </Suspense>
      <div className="page-full flex-1 md:grid md:grid-cols-[15rem_minmax(0,1fr)] md:gap-x-(--grid-gap)">
        <Suspense fallback={<AdminSidebar />}>
          <SidebarWithQueue />
        </Suspense>
        <main id="main" className="min-w-0 pb-(--section-space)">
          <NavSentinel />
          {children}
        </main>
      </div>
    </div>
  );
}

async function SessionAdminBar() {
  let account: NavAccount | undefined;
  try {
    const viewer = await getViewer();
    account = viewer
      ? { name: viewer.name, initials: initials(viewer.name), adminHref: adminHref(viewer.role) }
      : undefined;
  } catch (error) {
    unstable_rethrow(error);
    log().error({ err: error }, 'cannot read the session for the admin bar');
  }
  return <AdminBar account={account} />;
}

/**
 * The sidebar with the review queue's count. A count api can't give right now costs only the badge: the
 * sidebar is how every admin page is reached, so it never fails with it.
 */
async function SidebarWithQueue() {
  let toReview = 0;
  try {
    const { jobs } = await adminRead('/api/v1/admin/listings?limit=100', ListingJobListResponse, '/admin');
    toReview = jobs.filter(isToReview).length;
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error }, 'cannot count the listings to review for the admin sidebar');
  }
  return <CurrentAdminSidebar toReview={toReview} />;
}
