import {
  DevUsersResponse,
  DropListResponse,
  type DropSummary,
  ProductDetail,
  type SessionUser,
  Slug,
  StockSnapshot,
} from '@flashdrop/contracts';
import type { PublicDropStatus } from '@flashdrop/domain';
import { cacheLife, cacheTag } from 'next/cache';
import { cache } from 'react';
import { ApiError, apiGet } from './api';

/*
 * Catalog reads for Server Components (design §8.1). The `'use cache'` helpers run only at request time,
 * because every caller first awaits `io()`, `params` or cookies inside a <Suspense>: a cached function that
 * ran during `next build` would need an api that does not exist there (§8.1 build rule, spike §3.5).
 * Errors are never cached: a failed read throws out of the cache scope and the route's error state renders.
 */

/** Drops for the storefront lists, tagged `drops` so the scheduler and admin actions can revalidate them. */
export async function getDrops(statuses: readonly PublicDropStatus[], limit: number): Promise<DropSummary[]> {
  'use cache';
  cacheTag('drops');
  cacheLife('minutes');
  const query = new URLSearchParams({ status: statuses.join(','), limit: String(limit) });
  const { drops } = await apiGet(`/api/v1/drops?${query}`, DropListResponse);
  return drops;
}

/**
 * A published product and its current drop, or `null` for an unknown slug. A malformed slug never reaches
 * api or the cache, so junk URLs cannot fill it.
 */
export async function getProduct(slug: string): Promise<ProductDetail | null> {
  return Slug.safeParse(slug).success ? getProductBySlug(slug) : null;
}

/**
 * Found products are tagged `product:<id>` (publishing calls `updateTag` with it) and kept for hours. A miss
 * is kept for seconds only: the tag a later publish revalidates is not known yet, so a long-lived miss
 * would hide the new product.
 */
async function getProductBySlug(slug: string): Promise<ProductDetail | null> {
  'use cache';
  try {
    const detail = await apiGet(`/api/v1/products/${slug}`, ProductDetail);
    cacheTag(`product:${detail.product.id}`);
    cacheLife('hours');
    return detail;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
    cacheLife('seconds');
    return null;
  }
}

/**
 * The live stock snapshot, never cached: it is the number the raw HTML must carry (SD §8.1). Memoised per
 * request, so the status line and the purchase panel of one render share a single read.
 */
export const getStock = cache(
  async (dropId: string): Promise<StockSnapshot> => apiGet(`/api/v1/drops/${dropId}/stock`, StockSnapshot),
);

/** The seeded accounts `/login` offers. They change only when the seed does. */
export async function getDevUsers(): Promise<SessionUser[]> {
  'use cache';
  cacheTag('dev-users');
  cacheLife('hours');
  const { users } = await apiGet('/api/v1/auth/dev-users', DevUsersResponse);
  return users;
}
