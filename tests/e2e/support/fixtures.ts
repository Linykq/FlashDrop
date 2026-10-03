import {
  OrderResponse,
  type OrderView,
  ProductDetail,
  StockSnapshot,
  TEST_SECRET_HEADER,
  type TestDropBody,
  TestDropResponse,
  TestSessionsResponse,
} from '@flashdrop/contracts';
import { type APIRequestContext, type BrowserContext, test as base, expect } from '@playwright/test';
import type { z } from 'zod';

/*
 * Isolation (design §13): every spec that touches stock gets its own product and drop from
 * `POST /api/v1/test/drops`, armed and open from now, with its own stock, limit and hold, and its own buyer
 * from `POST /api/v1/test/sessions`. No spec shares stock or a per-user limit with another, so specs run in
 * parallel on a shared stack. Test products have pages but are never listed, so the seeded catalog the home
 * page shows stays as seeded.
 *
 *   test.use({ dropSettings: { stock: 1, holdSeconds: 10 } });
 *   test('...', async ({ page, drop, buyer }) => { await page.goto(`/p/${drop.productSlug}`); ... });
 */

/** The stack's `TEST_ROUTES_SECRET`: compose.yaml's dev-only default unless the run sets another. */
const TEST_SECRET = process.env.TEST_ROUTES_SECRET || 'dev-only-test-routes-secret';
/** api's session cookie (§11), which `POST /test/sessions` signs a value for. */
const SESSION_COOKIE = 'fd_session';

export type DropSettings = Partial<z.input<typeof TestDropBody>>;

const DEFAULT_DROP: z.input<typeof TestDropBody> = {
  stock: 10,
  perUserLimit: 2,
  holdSeconds: 120,
  paymentSeconds: 300,
};

export interface TestDrop {
  readonly id: string;
  readonly productSlug: string;
  readonly settings: z.input<typeof TestDropBody>;
}

export interface Buyer {
  readonly userId: string;
}

/**
 * Mutating requests carry an allowed `Origin` (api's CSRF guard, §11): the suite's own origin, which every
 * stack lists in `WS_ALLOWED_ORIGINS`.
 */
function origin(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error('playwright.config.ts sets no baseURL');
  return new URL(baseURL).origin;
}

async function postTestRoute<T extends z.ZodType>(
  request: APIRequestContext,
  baseURL: string | undefined,
  path: string,
  body: unknown,
  status: number,
  schema: T,
): Promise<z.output<T>> {
  const response = await request.post(path, {
    data: body,
    headers: { origin: origin(baseURL), [TEST_SECRET_HEADER]: TEST_SECRET },
  });
  if (response.status() === 404) {
    throw new Error(
      `POST ${path} answered 404: start the stack with ENABLE_TEST_ROUTES=true (pnpm stack:up)`,
    );
  }
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(status);
  return schema.parse(await response.json());
}

/** `GET /drops/:dropId/stock`: the level the storefront shows, from Redis. */
export async function stockOf(request: APIRequestContext, dropId: string): Promise<StockSnapshot> {
  const response = await request.get(`/api/v1/drops/${dropId}/stock`);
  expect(response.status(), `GET stock of ${dropId}`).toBe(200);
  return StockSnapshot.parse(await response.json());
}

/*
 * Reads for `expect.poll`. Playwright fails a poll at once when its callback throws, so these return
 * `undefined` for the answers that only say "ask again": 503 RETRY while the drop is RECONCILING or not yet
 * rebuilt (a nudge after a Postgres refusal, a structural fix, lost keys; design §4.7), and 502 or 504 from
 * Caddy while an api instance restarts. Any other answer still fails the test.
 */
const ASK_AGAIN = new Set([502, 503, 504]);

async function pollRead<T extends z.ZodType>(
  request: APIRequestContext,
  path: string,
  schema: T,
): Promise<z.output<T> | undefined> {
  const response = await request.get(path);
  if (ASK_AGAIN.has(response.status())) return undefined;
  expect(response.status(), `GET ${path}`).toBe(200);
  return schema.parse(await response.json());
}

/** `stockOf` for `expect.poll`: `undefined` while api asks to retry. */
export function pollStock(request: APIRequestContext, dropId: string): Promise<StockSnapshot | undefined> {
  return pollRead(request, `/api/v1/drops/${dropId}/stock`, StockSnapshot);
}

/** `orderOf` for `expect.poll`: `undefined` while api asks to retry. */
export async function pollOrder(request: APIRequestContext, orderId: string): Promise<OrderView | undefined> {
  return (await pollRead(request, `/api/v1/orders/${orderId}`, OrderResponse))?.order;
}

/** `GET /products/:slug`: the product and its drop, as the product page reads them. */
export async function productOf(request: APIRequestContext, slug: string): Promise<ProductDetail> {
  const response = await request.get(`/api/v1/products/${slug}`);
  expect(response.status(), `GET product ${slug}`).toBe(200);
  return ProductDetail.parse(await response.json());
}

/**
 * A fresh drop, waited on until it is LIVE. Lua admits from `startsAt` already, but the storefront words a
 * drop by its status (a SCHEDULED one shows its countdown), which the scheduler flips within a second (§4.6).
 */
export async function createDrop(
  request: APIRequestContext,
  baseURL: string | undefined,
  settings: DropSettings = {},
): Promise<TestDrop> {
  const body = { ...DEFAULT_DROP, ...settings };
  const { dropId, productSlug } = await postTestRoute(
    request,
    baseURL,
    '/api/v1/test/drops',
    body,
    201,
    TestDropResponse,
  );
  await expect
    .poll(async () => (await pollStock(request, dropId))?.status, {
      message: `drop ${dropId} goes LIVE (is the worker running?)`,
      timeout: 10_000,
    })
    .toBe('LIVE');
  return { id: dropId, productSlug, settings: body };
}

/** A fresh buyer, signed in to `context` with the session api signed for it. */
export async function signInNewBuyer(
  request: APIRequestContext,
  baseURL: string | undefined,
  context: BrowserContext,
): Promise<Buyer> {
  const { sessions } = await postTestRoute(
    request,
    baseURL,
    '/api/v1/test/sessions',
    { count: 1 },
    200,
    TestSessionsResponse,
  );
  const [session] = sessions;
  if (session === undefined) throw new Error('POST /test/sessions minted no session');
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: session.token,
      url: origin(baseURL),
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  return { userId: session.userId };
}

/**
 * Reserves through the api with the session of `request` (a context's `request`, which shares its cookies),
 * the way the Buy button does. For specs that need a hold before they open a page.
 */
export async function reserveViaApi(
  request: APIRequestContext,
  baseURL: string | undefined,
  dropId: string,
  qty = 1,
): Promise<OrderView> {
  const response = await request.post(`/api/v1/drops/${dropId}/reservations`, {
    data: { qty },
    headers: { origin: origin(baseURL), 'idempotency-key': `e2e_${crypto.randomUUID()}` },
  });
  expect(response.status(), `reserve on ${dropId}: ${await response.text()}`).toBe(201);
  return OrderResponse.parse(await response.json()).order;
}

/** `GET /orders/:orderId` with the owner's session. */
export async function orderOf(request: APIRequestContext, orderId: string): Promise<OrderView> {
  const response = await request.get(`/api/v1/orders/${orderId}`);
  expect(response.status(), `GET order ${orderId}`).toBe(200);
  return OrderResponse.parse(await response.json()).order;
}

export const test = base.extend<{
  /** The settings of the spec's drop; override with `test.use({ dropSettings: {...} })`. */
  dropSettings: DropSettings;
  /** The spec's own drop, LIVE. */
  drop: TestDrop;
  /** A fresh buyer, signed in to the spec's browser context (and so to `page.request`). */
  buyer: Buyer;
}>({
  dropSettings: [{}, { option: true }],
  drop: async ({ request, baseURL, dropSettings }, use) => {
    await use(await createDrop(request, baseURL, dropSettings));
  },
  buyer: async ({ request, baseURL, context }, use) => {
    await use(await signInNewBuyer(request, baseURL, context));
  },
});

export { expect };
