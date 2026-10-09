import {
  AdminDropListResponse,
  AdminProductListResponse,
  AdminRoomListResponse,
  Uuid,
} from '@flashdrop/contracts';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { parseDropFilter } from '../../../components/admin/drop-filter';
import { DropsSkeleton, DropsView } from '../../../components/admin/drops-view';
import { adminRead } from '../_lib/api';

export const metadata: Metadata = { title: 'Drops' };

const RETURN_TO = '/admin/drops';
/** Enough for the catalog's drops; the oldest ended ones fall off first (`AdminDropListResponse` order). */
const LIST_LIMIT = 200;

/*
 * Every drop of the catalog, DRAFT included (design system §10.8), read per request with the admin's session:
 * the list changes with every action an admin takes. `?status=` keeps the filter in the URL and
 * `?new=<productId>` opens the "New drop" sheet with that product chosen (the product page's "Create drop").
 */
export default function DropsPage({ searchParams }: PageProps<'/admin/drops'>) {
  return (
    <Suspense fallback={<DropsSkeleton />}>
      <Drops searchParams={searchParams} />
    </Suspense>
  );
}

async function Drops({ searchParams }: Pick<PageProps<'/admin/drops'>, 'searchParams'>) {
  const query = await searchParams;
  const [{ drops }, { products }, { rooms }] = await Promise.all([
    adminRead(`/api/v1/admin/drops?limit=${LIST_LIMIT}`, AdminDropListResponse, RETURN_TO),
    adminRead('/api/v1/admin/products', AdminProductListResponse, RETURN_TO),
    adminRead('/api/v1/admin/rooms', AdminRoomListResponse, RETURN_TO),
  ]);
  const newProduct = Uuid.safeParse(query.new);
  return (
    <DropsView
      drops={drops}
      products={products}
      rooms={rooms}
      initialFilter={parseDropFilter(query.status)}
      newProductId={newProduct.success ? newProduct.data : null}
    />
  );
}
