import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createLogger, postgresCheck } from '@flashdrop/config';
import {
  PspChargeList,
  PspChargeResponse,
  PspCloseResponse,
  PspErrorBody,
  PspLedgerResponse,
} from '@flashdrop/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type PspApp } from './app';
import { createSimulation, type SimulationConfig } from './simulation';
import { createPspTestDatabase, type PspTestDatabase } from './test/database';

/*
 * The service over a real socket and the real ledger (design §6.5, the M4 demo): timeout-after-success
 * leaves exactly one charge, a late payment is refunded, a simulated error records nothing, and the ledger
 * adds up.
 */

let psp: PspTestDatabase;
beforeAll(async () => {
  psp = await createPspTestDatabase();
});
afterAll(() => psp?.close());

const apps: PspApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const logger = createLogger({ name: 'payment-mock-int', level: 'silent' });
const API_KEY = 'int-test-psp-api-key-at-least-32-chars';
const AUTH = { authorization: `Bearer ${API_KEY}` };

async function start(config: Partial<SimulationConfig> = {}): Promise<string> {
  const simulation = createSimulation(
    { latency: { minMs: 0, maxMs: 0 }, errorRate: 0, timeoutAfterSuccessRate: 0, ...config },
    { hangMs: 60_000 },
  );
  const app = await buildApp({
    logger,
    apiKey: API_KEY,
    ledger: psp.ledger,
    simulation,
    checks: { postgres: postgresCheck(psp.pool) },
  });
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

function post(url: string, idempotencyKey: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
}

const AMOUNT = 4_250;
const chargeBody = (reference: string, paymentMethod = 'pm_ok') => ({
  reference,
  amountCents: AMOUNT,
  paymentMethod,
});

async function charge(base: string, reference: string, key = `charge:${reference}`, method = 'pm_ok') {
  const response = await post(`${base}/v1/charges`, key, chargeBody(reference, method));
  expect(response.status).toBe(200);
  return PspChargeResponse.parse(await response.json());
}

async function close(base: string, reference: string) {
  const response = await post(`${base}/v1/references/${reference}/close`, `close:${reference}`);
  expect(response.status).toBe(200);
  return PspCloseResponse.parse(await response.json());
}

async function chargesOf(base: string, reference: string) {
  const response = await fetch(`${base}/v1/charges?reference=${reference}`, { headers: AUTH });
  expect(response.status).toBe(200);
  return PspChargeList.parse(await response.json()).charges;
}

async function ledger(base: string) {
  return PspLedgerResponse.parse(await (await fetch(`${base}/v1/admin/ledger`, { headers: AUTH })).json());
}

describe('timeout after success', () => {
  it('leaves exactly one charge, and the retry with the same key is answered with it', async () => {
    const base = await start({ timeoutAfterSuccessRate: 1 });
    const reference = randomUUID();

    // The charge commits, then the answer never comes: the caller's own timeout ends the call.
    const lost = post(
      `${base}/v1/charges`,
      `charge:${reference}`,
      chargeBody(reference),
      AbortSignal.timeout(500),
    );
    await expect(lost).rejects.toMatchObject({ name: 'TimeoutError' });
    const [recorded] = await chargesOf(base, reference);
    expect(recorded).toMatchObject({ status: 'succeeded', amountCents: AMOUNT });

    // A replay is never withheld, so the unknown outcome resolves to the recorded charge.
    const retry = await post(`${base}/v1/charges`, `charge:${reference}`, chargeBody(reference));
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(await retry.json()).toEqual({ status: 'succeeded', id: recorded?.id });
    expect(await chargesOf(base, reference)).toHaveLength(1);
  });
});

describe('a late payment', () => {
  it('is refunded by the close, and every later charge of the reference is refused', async () => {
    const base = await start();
    const reference = randomUUID();
    const before = await ledger(base);

    const paid = await charge(base, reference);
    if (paid.status !== 'succeeded') throw new Error(`expected a succeeded charge, got ${paid.status}`);
    const refund = await close(base, reference);
    expect(refund).toEqual({ refundedChargeId: paid.id, amountCents: AMOUNT });
    // close:<orderId> replays the same refund.
    expect(await close(base, reference)).toEqual(refund);
    expect(await charge(base, reference, `again:${reference}`)).toEqual({
      status: 'reference_closed',
      declineCode: 'reference_closed',
    });

    expect(await chargesOf(base, reference)).toMatchObject([
      { status: 'refunded', refundedAt: expect.any(String) },
    ]);
    const after = await ledger(base);
    expect(after.capturedCents - before.capturedCents).toBe(0);
    expect(after.refundedCents - before.refundedCents).toBe(AMOUNT);
  });
});

describe('a simulated PSP error', () => {
  it('answers 503 and records nothing, for a charge and for a close', async () => {
    const base = await start({ errorRate: 1 });
    const reference = randomUUID();

    const charged = await post(`${base}/v1/charges`, `charge:${reference}`, chargeBody(reference));
    expect(charged.status).toBe(503);
    expect(charged.headers.get('retry-after')).toBe('1');
    expect(PspErrorBody.parse(await charged.json()).error.code).toBe('unavailable');
    const closed = await post(`${base}/v1/references/${reference}/close`, `close:${reference}`);
    expect(closed.status).toBe(503);

    expect(await chargesOf(base, reference)).toEqual([]);
    const { rows } = await psp.admin.pool.query('SELECT 1 FROM psp."references" WHERE reference = $1', [
      reference,
    ]);
    expect(rows).toEqual([]);
  });
});

describe('GET /v1/admin/ledger', () => {
  it('adds up every outcome', async () => {
    const base = await start();
    const before = await ledger(base);
    const [paid, declined, refunded, fenced, doubled] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];

    await charge(base, paid);
    await charge(base, declined, `charge:${declined}`, 'pm_decline');
    await charge(base, refunded);
    await close(base, refunded);
    await close(base, fenced);
    await charge(base, fenced);
    await charge(base, doubled);
    await charge(base, doubled, `second:${doubled}`);

    const after = await ledger(base);
    expect({
      succeeded: after.charges.succeeded - before.charges.succeeded,
      declined: after.charges.declined - before.charges.declined,
      refunded: after.charges.refunded - before.charges.refunded,
      capturedCents: after.capturedCents - before.capturedCents,
      refundedCents: after.refundedCents - before.refundedCents,
      open: after.references.open - before.references.open,
      closed: after.references.closed - before.references.closed,
    }).toEqual({
      succeeded: 3,
      declined: 1,
      refunded: 1,
      capturedCents: 3 * AMOUNT,
      refundedCents: AMOUNT,
      open: 3,
      closed: 2,
    });
    expect(after.doubleCaptured).toContainEqual({
      reference: doubled,
      charges: 2,
      capturedCents: 2 * AMOUNT,
    });
    expect(after.doubleCaptured.map((entry) => entry.reference)).not.toContain(paid);
  });
});

describe('GET /health', () => {
  it('is ready when the ledger answers as the psp role', async () => {
    const base = await start();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: 'ok' } });
  });
});

describe('the API key', () => {
  it('keeps a caller without it from refunding a captured charge or reading the ledger', async () => {
    const base = await start();
    const reference = randomUUID();
    expect(await charge(base, reference)).toMatchObject({ status: 'succeeded' });

    const refund = await fetch(`${base}/v1/references/${reference}/close`, {
      method: 'POST',
      headers: { 'idempotency-key': `close:${reference}` },
    });
    expect(refund.status).toBe(401);
    expect(PspErrorBody.parse(await refund.json()).error.code).toBe('unauthorized');
    expect((await fetch(`${base}/v1/admin/ledger`)).status).toBe(401);

    expect(await chargesOf(base, reference)).toEqual([expect.objectContaining({ status: 'succeeded' })]);
  });
});
