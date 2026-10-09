import { createReservationService, type ReserveRequest } from '@flashdrop/inventory';
import { afterEach, describe, expect, it } from 'vitest';
import type { Api } from './http/api';
import {
  countAdminRebuild,
  countWsFrame,
  instrumentReservations,
  registry,
  timeReserveTransaction,
  wsSocketClosed,
  wsSocketOpened,
} from './metrics';
import { BUYER, buildTestApp, fakeReservePorts, fakeState, LIVE_DROP, NOW } from './test/fakes';

/** One sample as Prometheus scrapes it, e.g. `fd_reserve_total{result="created"}`; 0 while absent. */
async function scraped(series: string): Promise<number> {
  const line = (await registry.metrics()).split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
}

let app: Api | undefined;
afterEach(() => app?.close());

describe('GET /metrics', () => {
  it('serves every api series of design §12 in the Prometheus text format', async () => {
    app = await buildTestApp();
    const response = await app.inject({ url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(registry.contentType);
    expect(response.headers['cache-control']).toBe('no-store');
    for (const [name, type] of [
      ['fd_reserve_total', 'counter'],
      ['fd_reserve_duration_seconds', 'histogram'],
      ['fd_pg_reserve_txn_seconds', 'histogram'],
      ['fd_rebuilds_total', 'counter'],
      ['fd_ws_sockets', 'gauge'],
      ['fd_ws_frames_sent_total', 'counter'],
    ]) {
      expect(response.body).toContain(`# TYPE ${name} ${type}`);
    }
  });

  it('is served without the http role, by a ws-only instance', async () => {
    app = await buildTestApp({ roles: ['ws'] });
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(200);
  });
});

describe('instrumentReservations', () => {
  const state = fakeState();
  const ports = timeReserveTransaction(fakeReservePorts(state));
  const reservations = instrumentReservations(createReservationService(ports, () => NOW));
  const log = { error: () => undefined, warn: () => undefined };
  const request = (idempotencyKey: string): ReserveRequest => ({
    userId: BUYER.id,
    dropId: LIVE_DROP.id,
    idempotencyKey,
    qty: 1,
    traceId: 'trace-metrics',
  });

  it('counts and times each reserve once, by the result its caller got', async () => {
    const results = ['created', 'replayed', 'sold_out', 'retry', 'error'];
    const before = await Promise.all(
      results.flatMap((result) => [
        scraped(`fd_reserve_total{result="${result}"}`),
        scraped(`fd_reserve_duration_seconds_count{result="${result}"}`),
      ]),
    );
    const transactions = await scraped('fd_pg_reserve_txn_seconds_count');

    // A new hold, then the same key again: a replay, answered without a second transaction.
    await reservations.reserve(request('key-metrics-1'), log);
    state.reserve.admit = () => ({ kind: 'EXISTING', state: 'HELD', gen: 1 });
    await reservations.reserve(request('key-metrics-1'), log);
    state.reserve.admit = () => ({ kind: 'SOLD_OUT' });
    await expect(reservations.reserve(request('key-metrics-2'), log)).rejects.toThrow('sold out');
    state.reserve.admit = () => ({ kind: 'RETRY' });
    await expect(reservations.reserve(request('key-metrics-3'), log)).rejects.toThrow('rebuilt');
    state.reserve.admit = () => {
      throw new Error('socket closed');
    };
    await expect(reservations.reserve(request('key-metrics-4'), log)).rejects.toThrow('socket closed');

    const after = await Promise.all(
      results.flatMap((result) => [
        scraped(`fd_reserve_total{result="${result}"}`),
        scraped(`fd_reserve_duration_seconds_count{result="${result}"}`),
      ]),
    );
    expect(after.map((value, i) => value - (before[i] ?? 0))).toEqual(results.flatMap(() => [1, 1]));
    expect(await scraped('fd_pg_reserve_txn_seconds_count')).toBe(transactions + 1);
  });
});

describe('the other api series', () => {
  it('counts admin rebuilds, open sockets and frames', async () => {
    const rebuilds = await scraped('fd_rebuilds_total{reason="admin"}');
    const sockets = await scraped('fd_ws_sockets');
    const frames = await scraped('fd_ws_frames_sent_total');

    countAdminRebuild();
    wsSocketOpened();
    wsSocketOpened();
    wsSocketClosed();
    countWsFrame();

    expect(await scraped('fd_rebuilds_total{reason="admin"}')).toBe(rebuilds + 1);
    expect(await scraped('fd_ws_sockets')).toBe(sockets + 1);
    expect(await scraped('fd_ws_frames_sent_total')).toBe(frames + 1);
    wsSocketClosed();
  });
});
