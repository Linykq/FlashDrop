import type {
  CancelQuery,
  CheckoutBody,
  IDEMPOTENCY_KEY_HEADER,
  OrderStatus,
  OrderView,
  PROBLEM_CONTENT_TYPE,
} from '@flashdrop/contracts';
import { ORDER_STATUSES } from '@flashdrop/domain';
import { noteServerTime } from './clock';

/*
 * The browser's order requests (SD §5.1), same-origin with the session cookie: checkout submit, the one-time
 * hold extension, cancel, and a read of an order's status. Each answer is classified into the outcomes the UI
 * acts on. The module loads as its own chunk after the page settles (`use-order-requests.ts`).
 *
 * Bodies are checked with small type guards rather than the Zod contracts, like the reserve request's
 * (`reserve.ts`): the contracts would add about 90 KB gzipped to checkout (design-system §14), and the browser
 * reads only an order's status and hold and a problem's `code` and field paths. Everything a page renders comes
 * from the server, which parses api's answers with the contracts (`lib/server/orders.ts`); the order page
 * asks the server again when a read here shows the status changed.
 *
 * None of these retry by themselves: checkout's retry is the buyer pressing Pay again with the same key, and
 * extend and cancel are compare-and-sets that a retry can't apply twice. Every order that comes back carries
 * the server's clock, which measures the tab's offset to it on the way (`noteServerTime`).
 */

const KEY_HEADER: typeof IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const PROBLEM_TYPE: typeof PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** A request never waits longer; a submit that timed out may still have landed, and a retry replays it. */
const TIMEOUT_MS = 10_000;

/** An answer, with when it was asked for and when it arrived (device time), which measure the server's clock. */
type Answer = { response: Response; sentAt: number; receivedAt: number };

/** `null` when no answer arrived: offline, a dropped connection, or the timeout. Rejects only on `signal`. */
async function send(path: string, init: RequestInit, signal: AbortSignal): Promise<Answer | null> {
  const sentAt = Date.now();
  try {
    const response = await fetch(path, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    return { response, sentAt, receivedAt: Date.now() };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isInstant = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isStatus = (value: unknown): value is OrderStatus =>
  typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);

/** The part of a `ProblemDetails` body the UI branches on. */
type Problem = { code: string | undefined; issues: { path: string }[] };

async function problemOf(response: Response): Promise<Problem> {
  if (!response.headers.get('content-type')?.startsWith(PROBLEM_TYPE)) return { code: undefined, issues: [] };
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body)) return { code: undefined, issues: [] };
  const issues = Array.isArray(body.errors)
    ? body.errors.filter(
        (issue): issue is { path: string } => isRecord(issue) && typeof issue.path === 'string',
      )
    : [];
  return { code: typeof body.code === 'string' ? body.code : undefined, issues };
}

/** What the browser acts on in an order: its status and its hold (`OrderView`). */
export type OrderState = Pick<OrderView, 'status' | 'expiresAt' | 'extensions' | 'serverNow'>;

/** An `OrderResponse` body's order state, or `null` for anything else. */
function orderStateOf(body: unknown): OrderState | null {
  if (!isRecord(body) || !isRecord(body.order)) return null;
  const { status, expiresAt, extensions, serverNow } = body.order;
  if (!isStatus(status) || !isInstant(expiresAt) || !isInstant(serverNow)) return null;
  if (!Number.isInteger(extensions) || Number(extensions) < 0) return null;
  return { status, expiresAt, extensions: Number(extensions), serverNow };
}

/** The order state of a 200, or `null` (reported: api broke its contract) when the body doesn't hold one. */
async function orderStateIn({ response, sentAt, receivedAt }: Answer): Promise<OrderState | null> {
  const state = orderStateOf(await response.json().catch(() => undefined));
  if (state === null) reportError(new Error(`${response.url} answered 200 without an order`));
  else noteServerTime(Date.parse(state.serverNow), sentAt, receivedAt);
  return state;
}

const orderPath = (orderId: string, action?: 'checkout' | 'extend' | 'cancel') =>
  `/api/v1/orders/${encodeURIComponent(orderId)}${action ? `/${action}` : ''}`;

export type CheckoutOutcome =
  /** 202, or 200 replaying this key's earlier submit: the order is PENDING_PAYMENT or further. */
  | { kind: 'placed' }
  /**
   * 409 ALREADY_SUBMITTED (another tab submitted it with its own key), or 422 IDEMPOTENCY_KEY_REUSED: this
   * key's own earlier submit landed with other details, so the order was placed with those.
   */
  | { kind: 'already-placed' }
  /** Any other 409 (`CONFLICT`): the order left checkout another way, cancelled in another tab. */
  | { kind: 'closed' }
  /** 410 RESERVATION_EXPIRED. */
  | { kind: 'expired' }
  /** api refused the details, field by field (`ProblemDetails.errors`). */
  | { kind: 'invalid'; issues: readonly { path: string }[] }
  | { kind: 'signed-out' }
  /** No answer, a 5xx, or an answer this flow never expects. The key is kept, so Pay again replays. */
  | { kind: 'failed' };

/** `POST /orders/:orderId/checkout` with the order's Idempotency-Key (SD §5.2). */
export async function submitCheckout(
  { orderId, key, body }: { orderId: string; key: string; body: CheckoutBody },
  signal: AbortSignal,
): Promise<CheckoutOutcome> {
  const answer = await send(
    orderPath(orderId, 'checkout'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', [KEY_HEADER]: key },
      body: JSON.stringify(body),
    },
    signal,
  );
  if (answer === null) return { kind: 'failed' };
  const { response } = answer;
  switch (response.status) {
    case 200:
    case 202:
      return { kind: 'placed' };
    case 401:
      return { kind: 'signed-out' };
    case 410:
      return { kind: 'expired' };
    case 409:
      return (await problemOf(response)).code === 'ALREADY_SUBMITTED'
        ? { kind: 'already-placed' }
        : { kind: 'closed' };
    case 400:
    case 422: {
      const problem = await problemOf(response);
      if (problem.code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'already-placed' };
      return problem.issues.length > 0 ? { kind: 'invalid', issues: problem.issues } : { kind: 'failed' };
    }
    default:
      return { kind: 'failed' };
  }
}

export type HoldChangeOutcome =
  /** 200, with the order as it now is. */
  | { kind: 'done'; order: OrderState }
  /** 409 (or 404, 410): the compare-and-set found the order changed; read it to see how. */
  | { kind: 'refused' }
  | { kind: 'signed-out' }
  | { kind: 'failed' };

async function changeHold(path: string, signal: AbortSignal): Promise<HoldChangeOutcome> {
  const answer = await send(path, { method: 'POST' }, signal);
  if (answer === null) return { kind: 'failed' };
  switch (answer.response.status) {
    case 200: {
      const order = await orderStateIn(answer);
      return order ? { kind: 'done', order } : { kind: 'failed' };
    }
    case 401:
      return { kind: 'signed-out' };
    case 404:
    case 409:
    case 410:
      return { kind: 'refused' };
    default:
      return { kind: 'failed' };
  }
}

/**
 * `POST /orders/:orderId/extend`: the one-time +60 s (WCAG 2.2.1), a compare-and-set on a RESERVED order
 * that was never extended and hasn't expired.
 */
export function extendHold(orderId: string, signal: AbortSignal): Promise<HoldChangeOutcome> {
  return changeHold(orderPath(orderId, 'extend'), signal);
}

/** Leave cancels a hold, never an order being paid (`CancelQuery`). */
const HOLD_ONLY = { from: 'RESERVED' } as const satisfies CancelQuery;

/**
 * `POST /orders/:orderId/cancel?from=RESERVED`: RESERVED to CANCELLED, releasing the hold. Only a hold: a
 * submit whose answer was lost may have placed the order, or another tab or device may have paid it while
 * this page showed the hold, and a plain cancel would take that PENDING_PAYMENT order too and refund its
 * charge. With the precondition, api answers 409 instead (`refused`), and the order page shows the payment.
 */
export function cancelOrder(orderId: string, signal: AbortSignal): Promise<HoldChangeOutcome> {
  return changeHold(`${orderPath(orderId, 'cancel')}?${new URLSearchParams(HOLD_ONLY)}`, signal);
}

export type ReadOutcome =
  | { kind: 'ok'; order: OrderState }
  | { kind: 'signed-out' }
  | { kind: 'not-found' }
  | { kind: 'failed' };

/** `GET /orders/:orderId`: what the order page polls, and what checkout re-reads after a refusal. */
export async function readOrder(orderId: string, signal: AbortSignal): Promise<ReadOutcome> {
  const answer = await send(orderPath(orderId), { headers: { accept: 'application/json' } }, signal);
  if (answer === null) return { kind: 'failed' };
  const { status, ok } = answer.response;
  if (status === 401) return { kind: 'signed-out' };
  if (status === 404) return { kind: 'not-found' };
  if (!ok) return { kind: 'failed' };
  const order = await orderStateIn(answer);
  return order ? { kind: 'ok', order } : { kind: 'failed' };
}
