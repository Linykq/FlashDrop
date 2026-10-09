import { AdminProductListResponse, AdminRoomListResponse, StockSnapshot } from '@flashdrop/contracts';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DropDetailSkeleton, DropDetailView } from '../../../../components/admin/drop-detail-view';
import { ApiError, apiGet } from '../../../../lib/server/api';
import { adminRead } from '../../_lib/api';
import { readAdminDrop } from '../../_lib/reads';

export async function generateMetadata({ params }: PageProps<'/admin/drops/[dropId]'>): Promise<Metadata> {
  const drop = await readAdminDrop((await params).dropId);
  return { title: drop.product.title };
}

/*
 * One drop (design system §10.8): its status, the actions its status allows, live stock and settings. Read per
 * request with the admin's session; the actions are Server Actions that refresh this page when they land.
 */
export default function DropPage({ params }: PageProps<'/admin/drops/[dropId]'>) {
  return (
    <Suspense fallback={<DropDetailSkeleton />}>
      <Drop params={params} />
    </Suspense>
  );
}

/**
 * The drop's live Redis level for the stock card's first state, or `null`: a DRAFT has no Redis state, and an
 * armed drop answers 503 for a moment while it is rebuilt. The card then shows the stock of record.
 */
async function liveStock(dropId: string): Promise<StockSnapshot | null> {
  try {
    return await apiGet(`/api/v1/drops/${dropId}/stock`, StockSnapshot);
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

async function Drop({ params }: Pick<PageProps<'/admin/drops/[dropId]'>, 'params'>) {
  const drop = await readAdminDrop((await params).dropId);
  const returnTo = `/admin/drops/${drop.id}`;
  // Only a draft can be edited, so only a draft needs the sheet's choices.
  const [stock, products, rooms] = await Promise.all([
    drop.status === 'DRAFT' ? null : liveStock(drop.id),
    drop.status === 'DRAFT' ? adminRead('/api/v1/admin/products', AdminProductListResponse, returnTo) : null,
    drop.status === 'DRAFT' ? adminRead('/api/v1/admin/rooms', AdminRoomListResponse, returnTo) : null,
  ]);
  return (
    <DropDetailView
      drop={drop}
      stock={stock}
      products={products?.products ?? []}
      rooms={rooms?.rooms ?? []}
    />
  );
}
