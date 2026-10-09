import type { AddressInfo } from 'node:net';
import { createLogger } from '@flashdrop/config';
import { PspErrorBody } from '@flashdrop/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type DependencyCheck, type PspApp } from './app';
import type { ChargeResult, Ledger, Refund } from './ledger';
import { createSimulation, type SimulationConfig, SLOW_METHOD_DELAY_MS } from './simulation';

/*
 * The HTTP layer over a stub ledger: validation, the simulated failure modes, error mapping and the
 * withheld answer. The ledger's own behaviour is in ledger.int.test.ts.
 */

const logger = createLogger({ name: 'payment-mock-test', level: 'silent' });
const KEY = { 'idempotency-key': 'charge:order-1' };
const BODY = { reference: 'order-1', amountCents: 1_999, paymentMethod: 'pm_ok' };
const SUCCEEDED: ChargeResult = { kind: 'created', response: { status: 'succeeded', id: 'ch_1' } };

interface Setup {
  readonly ledger?: Partial<Ledger>;
  readonly simulation?: Partial<SimulationConfig>;
  readonly hangMs?: number;
  readonly checks?: Record<string, DependencyCheck>;
}

const apps: PspApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup({ ledger = {}, simulation = {}, hangMs = 60_000, checks = {} }: Setup = {}) {
  const stub: Ledger = {
    charge: vi.fn(ledger.charge ?? (async () => SUCCEEDED)),
    close: vi.fn(ledger.close ?? (async (): Promise<readonly Refund[]> => [])),
    chargesFor: vi.fn(ledger.chargesFor ?? (async () => [])),
    summary: vi.fn(
      ledger.summary ??
        (async () => ({
          charges: { succeeded: 0, declined: 0, refunded: 0 },
          capturedCents: 0,
          refundedCents: 0,
          references: { open: 0, closed: 0 },
          doubleCaptured: [],
        })),
    ),
  };
  const sleep = vi.fn(async () => undefined);
  const app = await buildApp({
    logger,
    ledger: stub,
    simulation: createSimulation(
      { latency: { minMs: 0, maxMs: 0 }, errorRate: 0, timeoutAfterSuccessRate: 0, ...simulation },
      { sleep, hangMs, random: () => 0.5 },
    ),
    checks,
  });
  apps.push(app);
  return { app, ledger: stub, sleep };
}

function postCharge(app: PspApp, body: unknown = BODY, headers: Record<string, string> = KEY) {
  return app.inject({ method: 'POST', url: '/v1/charges', headers, payload: body as object });
}

describe('POST /v1/charges', () => {
  it('answers the ledger result after the simulated latency', async () => {
    const { app, ledger, sleep } = await setup({ simulation: { latency: { minMs: 300, maxMs: 300 } } });
    const response = await postCharge(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'succeeded', id: 'ch_1' });
    expect(response.headers['idempotent-replayed']).toBeUndefined();
    expect(sleep).toHaveBeenCalledWith(300);
    expect(ledger.charge).toHaveBeenCalledWith({ ...BODY, idempotencyKey: 'charge:order-1' });
  });

  it('adds pm_slow processing time', async () => {
    const { app, sleep } = await setup();
    await postCharge(app, { ...BODY, paymentMethod: 'pm_slow' });
    expect(sleep).toHaveBeenCalledWith(SLOW_METHOD_DELAY_MS);
  });

  it('marks a replay', async () => {
    const replayed: ChargeResult = { kind: 'replayed', response: { status: 'succeeded', id: 'ch_1' } };
    const { app } = await setup({ ledger: { charge: async () => replayed } });
    const response = await postCharge(app);
    expect(response.headers['idempotent-replayed']).toBe('true');
    expect(response.json()).toEqual({ status: 'succeeded', id: 'ch_1' });
  });

  it('answers a fenced charge as reference_closed', async () => {
    const fenced: ChargeResult = {
      kind: 'fenced',
      response: { status: 'reference_closed', declineCode: 'reference_closed' },
    };
    const { app } = await setup({ ledger: { charge: async () => fenced } });
    expect((await postCharge(app)).json()).toEqual({
      status: 'reference_closed',
      declineCode: 'reference_closed',
    });
  });

  it('answers 422 for a key reused with a different request', async () => {
    const { app } = await setup({ ledger: { charge: async () => ({ kind: 'key_reused' }) } });
    const response = await postCharge(app);
    expect(response.statusCode).toBe(422);
    expect(PspErrorBody.parse(response.json()).error.code).toBe('idempotency_key_reused');
  });

  it.each([
    ['no Idempotency-Key', BODY, {}],
    ['an unknown payment method', { ...BODY, paymentMethod: 'pm_visa' }, KEY],
    ['a zero amount', { ...BODY, amountCents: 0 }, KEY],
    ['an amount beyond int4', { ...BODY, amountCents: 2 ** 31 }, KEY],
    ['an unknown field', { ...BODY, currency: 'USD' }, KEY],
    ['a reference with a slash', { ...BODY, reference: 'a/b' }, KEY],
  ])('refuses %s with 400 before touching the ledger', async (_case, body, headers) => {
    const { app, ledger, sleep } = await setup();
    const response = await postCharge(app, body, headers);
    expect(response.statusCode).toBe(400);
    expect(PspErrorBody.parse(response.json()).error.code).toBe('validation_failed');
    expect(ledger.charge).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('answers a simulated error with 503 and Retry-After, recording nothing', async () => {
    const { app, ledger } = await setup({ simulation: { errorRate: 1 } });
    const response = await postCharge(app);
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(PspErrorBody.parse(response.json()).error.code).toBe('unavailable');
    expect(ledger.charge).not.toHaveBeenCalled();
  });

  it('answers 503 when the ledger is briefly unreachable, and 500 for anything else', async () => {
    const unreachable = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const down = await setup({ ledger: { charge: () => Promise.reject(unreachable) } });
    expect((await postCharge(down.app)).statusCode).toBe(503);

    const broken = await setup({ ledger: { charge: () => Promise.reject(new Error('bug')) } });
    const response = await postCharge(broken.app);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal', message: 'Internal error' } });
  });
});

describe('timeout after success', () => {
  async function listen(app: PspApp): Promise<string> {
    await app.listen({ host: '127.0.0.1', port: 0 });
    return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/charges`;
  }

  function send(url: string, signal?: AbortSignal) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...KEY },
      body: JSON.stringify(BODY),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  it('records the charge and never answers, so the caller times out', async () => {
    const { app, ledger } = await setup({ simulation: { timeoutAfterSuccessRate: 1 } });
    const url = await listen(app);
    await expect(send(url, AbortSignal.timeout(300))).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(ledger.charge).toHaveBeenCalledTimes(1);
  });

  it('destroys the connection after hangMs', async () => {
    const { app } = await setup({ simulation: { timeoutAfterSuccessRate: 1 }, hangMs: 50 });
    const url = await listen(app);
    await expect(send(url, AbortSignal.timeout(5_000))).rejects.toMatchObject({ message: 'fetch failed' });
  });

  it('does not hold up shutdown', async () => {
    const { app, ledger } = await setup({ simulation: { timeoutAfterSuccessRate: 1 } });
    const url = await listen(app);
    const pending = send(url).catch((error: unknown) => error);
    await vi.waitFor(() => expect(ledger.charge).toHaveBeenCalled());
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await pending).toBeInstanceOf(Error);
  });

  it.each<[string, ChargeResult]>([
    ['a replay', { kind: 'replayed', response: { status: 'succeeded', id: 'ch_1' } }],
    [
      'a decline',
      { kind: 'created', response: { status: 'declined', id: 'ch_1', declineCode: 'card_declined' } },
    ],
  ])('always answers %s', async (_case, result) => {
    const { app } = await setup({
      simulation: { timeoutAfterSuccessRate: 1 },
      ledger: { charge: async () => result },
    });
    expect((await postCharge(app)).statusCode).toBe(200);
  });
});

describe('POST /v1/references/:reference/close', () => {
  const close = (app: PspApp, headers: Record<string, string> = { 'idempotency-key': 'close:order-1' }) =>
    app.inject({ method: 'POST', url: '/v1/references/order-1/close', headers });

  it('answers the refund, or nothing when nothing was captured', async () => {
    const refund = { chargeId: 'ch_1', amountCents: 1_999 };
    const refunded = await setup({ ledger: { close: async () => [refund] } });
    const response = await close(refunded.app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ refundedChargeId: 'ch_1', amountCents: 1_999 });
    expect(refunded.ledger.close).toHaveBeenCalledWith('order-1');

    const empty = await setup();
    expect((await close(empty.app)).json()).toEqual({});
  });

  it('accepts an empty body sent as JSON', async () => {
    const { app } = await setup();
    const response = await close(app, {
      'idempotency-key': 'close:order-1',
      'content-type': 'application/json',
    });
    expect(response.statusCode).toBe(200);
  });

  it('requires an Idempotency-Key and fails a simulated error before the ledger', async () => {
    const missing = await setup();
    expect((await close(missing.app, {})).statusCode).toBe(400);

    const failing = await setup({ simulation: { errorRate: 1 } });
    expect((await close(failing.app)).statusCode).toBe(503);
    expect(failing.ledger.close).not.toHaveBeenCalled();
  });
});

describe('audit routes', () => {
  it('lists the charges of a reference, which is required', async () => {
    const { app, ledger } = await setup();
    expect((await app.inject({ url: '/v1/charges' })).statusCode).toBe(400);
    const response = await app.inject({ url: '/v1/charges?reference=order-1' });
    expect(response.json()).toEqual({ charges: [] });
    expect(ledger.chargesFor).toHaveBeenCalledWith('order-1');
  });

  it('serves the ledger summary', async () => {
    const { app } = await setup();
    const response = await app.inject({ url: '/v1/admin/ledger' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ capturedCents: 0, doubleCaptured: [] });
  });

  it('answers unknown routes with 404', async () => {
    const { app } = await setup();
    const response = await app.inject({ url: '/v1/refunds' });
    expect(response.statusCode).toBe(404);
    expect(PspErrorBody.parse(response.json()).error.code).toBe('not_found');
  });
});

describe('health', () => {
  it('is ready only while every dependency answers; live regardless', async () => {
    const up = await setup({ checks: { postgres: async () => undefined } });
    expect((await up.app.inject({ url: '/health' })).json()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok' },
    });

    const down = await setup({ checks: { postgres: () => Promise.reject(new Error('down')) } });
    const response = await down.app.inject({ url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'unavailable', message: 'postgres unavailable' },
    });
    expect((await down.app.inject({ url: '/health/live' })).statusCode).toBe(200);
  });
});
