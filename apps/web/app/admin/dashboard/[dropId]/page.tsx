import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DashboardSkeleton, DashboardView } from '../../../../components/admin/dashboard-view';
import { readDashboard } from '../../_lib/reads';

export async function generateMetadata({
  params,
}: PageProps<'/admin/dashboard/[dropId]'>): Promise<Metadata> {
  const dashboard = await readDashboard((await params).dropId);
  return { title: `${dashboard.drop.product.title} dashboard` };
}

/*
 * The live sales dashboard (SD §9, design system §10.10). Its first state is server-rendered from
 * `GET /admin/dashboard/drops/:id` with the admin's session, never cached: it is the base the page's socket
 * frames build on, and a stale base would hide every frame older than it.
 */
export default function DashboardPage({ params }: PageProps<'/admin/dashboard/[dropId]'>) {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <Dashboard params={params} />
    </Suspense>
  );
}

async function Dashboard({ params }: Pick<PageProps<'/admin/dashboard/[dropId]'>, 'params'>) {
  return <DashboardView initial={await readDashboard((await params).dropId)} />;
}
