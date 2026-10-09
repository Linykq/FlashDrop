import {
  PSP_IDEMPOTENCY_KEY_HEADER,
  type PspChargeRequest,
  PspChargeResponse,
  PspCloseResponse,
} from '@flashdrop/contracts';
import { BugError, TransientError } from '@flashdrop/domain';
import type { z } from 'zod';
import { countPspRequest, type PspResult } from '../metrics';

/*
 * The payment consumer's client of the PSP (`apps/payment-mock`, design §6.5), across a real socket so that
 * timeouts and unknown outcomes are real.
 *
 * Every call carries a hard client-side timeout (5 s). It bounds the batch the call runs in, and the
 * slowest batch in flight gates the whole consumer member: its fetches, seeks and rebalances (M0 delta 5).
 *
 * Failures, by what they say about the PSP's state:
 * - a timeout, a socket error, 408, 429 or any 5xx: the outcome is UNKNOWN. The charge may have been
 *   recorded (timeout-after-success). `PspUnavailableError` is transient, so the runner retries the same
 *   message with the same Idempotency-Key, forever (§6.4): the PSP then answers with the recorded outcome,
 *   so an unknown outcome can never become a second charge;
 * - any other 4xx, or a 200 that breaks the contract (a field it does not know is not a break): our
 *   request or the PSP is wrong, and retrying the same request cannot fix it. A `BugError`: the runner
 *   retries it for a minute, then dead-letters it. Money stays safe either way: an order.placed given up on
 *   leaves the order to expire, and an expired or cancelled order whose close was given up on is closed
 *   again by the `close-unpaid` loop, which quarantines it and alerts if the close keeps failing.
 *
 * Every call counts once in `fd_psp_requests_total{op,result}` (§12): its answer, or which failure it was.
 */

/** §6.5: the PSP's answer must arrive within this, or the outcome is unknown. */
export const PSP_TIMEOUT_MS = 5_000;

export interface PspClient {
  /** `POST /v1/charges`: the same answer for every retry under one key. */
  charge(request: PspChargeRequest, idempotencyKey: string): Promise<PspChargeResponse>;
  /** `POST /v1/references/:reference/close`: refunds a captured charge and refuses every later one. */
  closeReference(reference: string, idempotencyKey: string): Promise<PspCloseResponse>;
}

export interface PspClientOptions {
  /** `PAYMENT_MOCK_URL`, e.g. http://payment-mock:4100. */
  readonly baseUrl: string;
  /** `PSP_API_KEY`, sent as `Authorization: Bearer <key>` on every call. */
  readonly apiKey: string;
  readonly timeoutMs?: number;
}

/** The PSP did not answer, or answered that it could not decide now: retry with the same key. */
export class PspUnavailableError extends TransientError {
  override name = 'PspUnavailableError';
}

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429]);

export function createPspClient({
  baseUrl,
  apiKey,
  timeoutMs = PSP_TIMEOUT_MS,
}: PspClientOptions): PspClient {
  const authorization = `Bearer ${apiKey}`;
  async function post<T>(
    op: 'charge' | 'close',
    path: string,
    idempotencyKey: string,
    body: unknown,
    schema: z.ZodType<T>,
    resultOf: (answer: T) => PspResult,
  ): Promise<T> {
    const call = `POST ${path}`;
    // One deadline for the whole exchange: the signal aborts the body read too.
    const signal = AbortSignal.timeout(timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await fetch(new URL(path, baseUrl), {
        method: 'POST',
        headers: {
          authorization,
          [PSP_IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      status = response.status;
      text = await response.text();
    } catch (cause) {
      // The deadline's signal tells a timeout from a connection that failed before it.
      countPspRequest(op, signal.aborted ? 'timeout' : 'unreachable');
      throw new PspUnavailableError(`PSP ${call} got no answer: ${describe(cause)}`, { cause });
    }
    if (status >= 500 || RETRYABLE_STATUSES.has(status)) {
      countPspRequest(op, 'unavailable');
      throw new PspUnavailableError(`PSP ${call} answered ${status}: ${text.slice(0, 500)}`);
    }
    if (status !== 200) {
      countPspRequest(op, 'refused');
      throw new BugError(`PSP ${call} refused the request (${status}): ${text.slice(0, 500)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      countPspRequest(op, 'invalid');
      throw new BugError(`PSP ${call} answered 200 with a body that is not JSON`, { cause });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      countPspRequest(op, 'invalid');
      throw new BugError(`PSP ${call} answered outside its contract: ${parsed.error.message}`);
    }
    countPspRequest(op, resultOf(parsed.data));
    return parsed.data;
  }

  return {
    charge: (request, idempotencyKey) =>
      post('charge', '/v1/charges', idempotencyKey, request, PspChargeResponse, (answer) => answer.status),
    closeReference: (reference, idempotencyKey) =>
      post(
        'close',
        `/v1/references/${encodeURIComponent(reference)}/close`,
        idempotencyKey,
        undefined,
        PspCloseResponse,
        (answer) => (answer.refundedChargeId === undefined ? 'closed' : 'refunded'),
      ),
  };
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // fetch wraps socket errors as `TypeError: fetch failed` with the real reason as the cause.
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  return `${error.name}: ${error.message}${cause}`;
}
