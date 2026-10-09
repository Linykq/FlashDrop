import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  PSP_IDEMPOTENCY_KEY_HEADER,
  PspChargeRequest,
  type PspChargeResponse,
  type PspCloseResponse,
} from '@flashdrop/contracts';
import { REFERENCE_CLOSED_DECLINE_CODE } from '@flashdrop/domain';

/*
 * A PSP for the payment consumer's integration tests, over a real socket, so the client's timeouts and
 * unknown outcomes are real. It keeps the contract of `apps/payment-mock` (design §6.5), with the failure
 * modes under the test's control instead of rates:
 *
 * - one reference's charges and closes run one at a time (the mock's reference row lock), so a close and a
 *   charge are strictly ordered: the charge came first and is refunded, or it comes second and is refused;
 * - an Idempotency-Key replays its first answer (a charge refunded later still replays `succeeded`); the
 *   same key with another body is 422;
 * - `pm_decline` is declined with `card_declined`; every other method succeeds.
 *
 * The ledger is the evidence: tests count a reference's charges and what is still captured.
 */

/** The fake's API key: like payment-mock, it answers 401 to any call without it. */
export const FAKE_PSP_API_KEY = 'fake-psp-api-key-at-least-32-chars';

export interface FakeCharge {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly reference: string;
  readonly amountCents: number;
  readonly paymentMethod: string;
  status: 'succeeded' | 'declined' | 'refunded';
}

export interface FakePsp {
  readonly url: string;
  /** Every charge recorded, oldest first. */
  charges(reference: string): readonly FakeCharge[];
  /** Captured and not refunded, in cents: INV-4 wants the order's total if PAID, else 0. */
  capturedCents(reference: string): number;
  isClosed(reference: string): boolean;
  /** Charge attempts received for the reference, replays and refusals included. */
  attempts(reference: string): number;
  /** Close requests received for the reference, replays, refusals and unanswered ones included. */
  closes(reference: string): number;
  /** Close requests received for any reference. */
  totalCloses(): number;
  /** The next `count` requests answer 503 before recording anything. */
  failNext(count: number): void;
  /** Closes of `reference` answer 400 without closing anything, until called with undefined. */
  refuseCloses(reference: string | undefined): void;
  /** Closes are received and never answered, as by a PSP that hangs, until called with false. */
  hangCloses(hang: boolean): void;
  /** The next charge that creates a success records it and never answers (timeout-after-success). */
  withholdNextSuccess(): void;
  /** Runs when a charge request arrives, before it takes its reference's lock. */
  beforeCharge(hook: ((reference: string) => Promise<void>) | undefined): void;
  /** Runs after a new charge is recorded and before it is answered, outside the reference's lock. */
  afterRecorded(hook: ((charge: FakeCharge) => Promise<void>) | undefined): void;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function startFakePsp(): Promise<FakePsp> {
  const charges: FakeCharge[] = [];
  const closed = new Set<string>();
  const attempts = new Map<string, number>();
  const closes = new Map<string, number>();
  const locks = new Map<string, Promise<unknown>>();
  let failures = 0;
  let refusedCloses: string | undefined;
  let hungCloses = false;
  let withholdSuccess = false;
  let chargeHook: ((reference: string) => Promise<void>) | undefined;
  let recordedHook: ((charge: FakeCharge) => Promise<void>) | undefined;

  /** Runs `fn` after every earlier call for the same reference has finished. */
  const serialized = <T>(reference: string, fn: () => T | Promise<T>): Promise<T> => {
    const previous = locks.get(reference) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(
      reference,
      next.catch(() => undefined),
    );
    return next;
  };

  const ofReference = (reference: string) => charges.filter((charge) => charge.reference === reference);

  async function charge(key: string, body: unknown, response: ServerResponse): Promise<void> {
    const parsed = PspChargeRequest.safeParse(body);
    if (!parsed.success) throw new HttpError(400, parsed.error.message);
    const request = parsed.data;
    attempts.set(request.reference, (attempts.get(request.reference) ?? 0) + 1);
    await chargeHook?.(request.reference);
    const outcome = await serialized(request.reference, () => {
      const previous = charges.find((c) => c.idempotencyKey === key);
      if (previous !== undefined) {
        const same =
          previous.reference === request.reference &&
          previous.amountCents === request.amountCents &&
          previous.paymentMethod === request.paymentMethod;
        if (!same) throw new HttpError(422, 'Idempotency-Key was used for a different request');
        return { created: undefined, answer: answerFor(previous) };
      }
      if (closed.has(request.reference)) {
        const refused: PspChargeResponse = {
          status: 'reference_closed',
          declineCode: REFERENCE_CLOSED_DECLINE_CODE,
        };
        return { created: undefined, answer: refused };
      }
      const created: FakeCharge = {
        id: `ch_fake_${charges.length + 1}`,
        idempotencyKey: key,
        reference: request.reference,
        amountCents: request.amountCents,
        paymentMethod: request.paymentMethod,
        status: request.paymentMethod === 'pm_decline' ? 'declined' : 'succeeded',
      };
      charges.push(created);
      return { created, answer: answerFor(created) };
    });
    if (outcome.created !== undefined) {
      await recordedHook?.(outcome.created);
      if (outcome.created.status === 'succeeded' && withholdSuccess) {
        withholdSuccess = false;
        return; // recorded, never answered: the socket stays silent until the client gives up
      }
    }
    send(response, 200, outcome.answer);
  }

  async function closeReference(reference: string, response: ServerResponse): Promise<void> {
    closes.set(reference, (closes.get(reference) ?? 0) + 1);
    if (hungCloses) return; // never answered: the socket stays silent until the client gives up
    if (reference === refusedCloses) throw new HttpError(400, 'simulated refusal of this close');
    const refunds = await serialized(reference, () => {
      closed.add(reference);
      for (const c of ofReference(reference)) if (c.status === 'succeeded') c.status = 'refunded';
      return ofReference(reference).filter((c) => c.status === 'refunded');
    });
    const [refund] = refunds;
    const answer: PspCloseResponse =
      refund === undefined ? {} : { refundedChargeId: refund.id, amountCents: refund.amountCents };
    send(response, 200, answer);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      send(response, status, { error: { code: 'internal', message: String(err) } });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    if (request.headers.authorization !== `Bearer ${FAKE_PSP_API_KEY}`)
      throw new HttpError(401, 'no API key');
    if (failures > 0) {
      failures--;
      throw new HttpError(503, 'simulated outage, nothing recorded');
    }
    const key = request.headers[PSP_IDEMPOTENCY_KEY_HEADER];
    if (request.method !== 'POST' || typeof key !== 'string') throw new HttpError(400, 'missing key');
    const url = new URL(request.url ?? '/', 'http://psp');
    if (url.pathname === '/v1/charges') return charge(key, body, response);
    const close = /^\/v1\/references\/([^/]+)\/close$/.exec(url.pathname);
    if (close?.[1] !== undefined) return closeReference(decodeURIComponent(close[1]), response);
    throw new HttpError(404, 'no such route');
  }

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake PSP has no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    charges: ofReference,
    capturedCents: (reference) =>
      ofReference(reference)
        .filter((c) => c.status === 'succeeded')
        .reduce((sum, c) => sum + c.amountCents, 0),
    isClosed: (reference) => closed.has(reference),
    attempts: (reference) => attempts.get(reference) ?? 0,
    closes: (reference) => closes.get(reference) ?? 0,
    totalCloses: () => [...closes.values()].reduce((sum, count) => sum + count, 0),
    failNext(count) {
      failures = count;
    },
    refuseCloses(reference) {
      refusedCloses = reference;
    },
    hangCloses(hang) {
      hungCloses = hang;
    },
    withholdNextSuccess() {
      withholdSuccess = true;
    },
    beforeCharge(hook) {
      chargeHook = hook;
    },
    afterRecorded(hook) {
      recordedHook = hook;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Withheld answers and hung closes keep their sockets open.
        server.closeAllConnections();
      }),
  };
}

function answerFor(charge: FakeCharge): PspChargeResponse {
  // A refunded charge replays as the success it was, as an idempotent replay must.
  return charge.status === 'declined'
    ? { status: 'declined', id: charge.id, declineCode: 'card_declined' }
    : { status: 'succeeded', id: charge.id };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
