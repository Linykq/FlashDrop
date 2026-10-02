import {
  DevUsersResponse,
  DropListResponse,
  type DropSummary,
  MeResponse,
  type SessionUser,
  StockSnapshot,
} from '@flashdrop/contracts';
import { type APIRequestContext, expect } from '@playwright/test';
import type { z } from 'zod';

/*
 * Reads of the public api, through Caddy like the browser's, each parsed with the contract api answers
 * with, so a spec fails on a shape change before it asserts anything about the page.
 *
 * TODO(M2): specs read the seeded drops until `POST /api/v1/test/drops` exists; then each spec creates
 * its own product and drop through a fixture (design §13), and stock may change under it.
 */

async function getJson<T extends z.ZodType>(
  request: APIRequestContext,
  path: string,
  schema: T,
): Promise<z.output<T>> {
  const response = await request.get(path);
  expect(response.status(), `GET ${path}`).toBe(200);
  return schema.parse(await response.json());
}

/** Every drop the home page can show: LIVE first, then by start (api's order). */
export async function openDrops(request: APIRequestContext): Promise<DropSummary[]> {
  const { drops } = await getJson(
    request,
    '/api/v1/drops?status=live,paused,scheduled&limit=50',
    DropListResponse,
  );
  return drops;
}

/** The drop the home hero features: the LIVE one that started first. */
export async function liveDrop(request: APIRequestContext): Promise<DropSummary> {
  const live = (await openDrops(request)).find((drop) => drop.status === 'LIVE');
  if (live === undefined) throw new Error('No LIVE drop: the seed places one; run `pnpm db:seed`');
  return live;
}

/** The uncached stock snapshot the product page streams into its HTML. */
export function stockSnapshot(request: APIRequestContext, dropId: string): Promise<StockSnapshot> {
  return getJson(request, `/api/v1/drops/${dropId}/stock`, StockSnapshot);
}

/** A seeded account with the buyer role, as the `/login` picker lists it. */
export async function seededBuyer(request: APIRequestContext): Promise<SessionUser> {
  const { users } = await getJson(request, '/api/v1/auth/dev-users', DevUsersResponse);
  const buyer = users.find((user) => user.role === 'buyer');
  if (buyer === undefined) throw new Error('No seeded buyer: run `pnpm db:seed`');
  return buyer;
}

/** The session's user, or `null` when api answers 401 (signed out). */
export async function sessionUser(request: APIRequestContext): Promise<SessionUser | null> {
  const response = await request.get('/api/v1/me');
  if (response.status() === 401) return null;
  expect(response.status(), 'GET /api/v1/me').toBe(200);
  return MeResponse.parse(await response.json()).user;
}
