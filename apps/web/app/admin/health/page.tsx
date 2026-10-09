import { AdminDropListResponse, AdminHealthResponse } from '@flashdrop/contracts';
import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { Suspense } from 'react';
import { HealthSkeleton, HealthView, type TrackedProduct } from '../../../components/admin/health-view';
import { log } from '../../../lib/server/log';
import { adminRead } from '../_lib/api';

export const metadata: Metadata = { title: 'Health' };

/** The check runs every invariant query over all tracked drops (SD §12): seconds, on a busy database. */
const HEALTH_TIMEOUT_MS = 15_000;
/** As the drops page: tracked drops are armed or ended within a day, near the top of the list's order. */
const LIST_LIMIT = 200;

/*
 * Operational health (design system §10.11): the first check is server-rendered with the admin's session, then
 * the page polls it every 5 s. api shares one check between callers for 2 s, so many open pages cost one.
 */
export default function HealthPage() {
  return (
    <Suspense fallback={<HealthSkeleton />}>
      <Health />
    </Suspense>
  );
}

async function Health() {
  const [initial, products] = await Promise.all([
    adminRead('/api/v1/admin/health', AdminHealthResponse, '/admin/health', {
      timeoutMs: HEALTH_TIMEOUT_MS,
    }),
    trackedProducts(),
  ]);
  return <HealthView initial={initial} products={products} />;
}

/**
 * The tracked drops' products, from the drops list, read once with the page: the health check names drops by
 * id only. The page is what an admin opens when something is wrong, so it must not fail with the list: without
 * it the rows show their ids alone. Drops armed after the page loaded do too, until it is loaded again.
 */
async function trackedProducts(): Promise<Record<string, TrackedProduct>> {
  try {
    const { drops } = await adminRead(
      `/api/v1/admin/drops?limit=${LIST_LIMIT}`,
      AdminDropListResponse,
      '/admin/health',
    );
    return Object.fromEntries(
      drops.map((drop) => [
        drop.id,
        { title: drop.product.title, imageKey: drop.product.imageKeys[0] ?? null },
      ]),
    );
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error }, 'health page: drops list unavailable; tracked drops show their ids');
    return {};
  }
}
