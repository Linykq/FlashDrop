import { DomainError } from '@flashdrop/domain';
import type { ReservationService, ReservePorts } from '@flashdrop/inventory';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { Api } from './http/api';

/*
 * The api's Prometheus series (design §12), served at `GET /metrics` on the api's own port. Caddy never
 * routes that path to an api (it answers 404 at the edge), so only the Compose network can scrape it.
 *
 * Reserves are measured around the service (`instrumentReservations`), so each one counts once, with the
 * result its caller got, whichever branch decided it; requests refused before the handler (429 rate limits,
 * 401 without a session) never reach the service and are not counted here.
 */

export const registry = new Registry();

/** Where the scrape endpoint is mounted, outside `/api/v1`. */
export const METRICS_PATH = '/metrics';

/**
 * Reserve latencies, from the 1 ms a refusal Lua answers alone takes up to the 5 s transaction bound (§3):
 * the burst profiles put winners near 0.2 s and a saturated laptop's p99 at several seconds (§5.2).
 */
const RESERVE_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** The reserve transaction holds the hot row for one commit: about 1 ms idle, more under a burst (§5.2). */
const TXN_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const reserves = new Counter({
  name: 'fd_reserve_total',
  help: 'Reserve requests by result: created, replayed, or the refusal code in lower case (§5.1).',
  labelNames: ['result'] as const,
  registers: [registry],
});

const reserveDuration = new Histogram({
  name: 'fd_reserve_duration_seconds',
  help: 'Time to decide a reserve, Lua admission and Postgres transaction included, by result (§5.2).',
  labelNames: ['result'] as const,
  buckets: RESERVE_BUCKETS,
  registers: [registry],
});

const pgReserveTxn = new Histogram({
  name: 'fd_pg_reserve_txn_seconds',
  help: 'Round trip of the reserve transaction (fd_record_reservation, one statement that commits), connection checkout included (§5.2).',
  buckets: TXN_BUCKETS,
  registers: [registry],
});

const rebuilds = new Counter({
  name: 'fd_rebuilds_total',
  help: 'Drops rebuilt from Postgres by this process, by reason: admin here, an admin reconcile or a status change that found Redis gone or mid-rebuild (§4.7).',
  labelNames: ['reason'] as const,
  registers: [registry],
});
// From 0, so that increase() sees the first one: a series created by its first event starts at 1.
rebuilds.inc({ reason: 'admin' }, 0);

const wsSockets = new Gauge({
  name: 'fd_ws_sockets',
  help: 'WebSockets open on this instance (§7).',
  registers: [registry],
});

const wsFramesSent = new Counter({
  name: 'fd_ws_frames_sent_total',
  help: 'Frames written to WebSockets: snapshots, coalesced levels, events, hello and beat (§7).',
  registers: [registry],
});

/** The label of a reserve that threw: the refusal's code, or `error` for anything that is not a refusal. */
function failureResult(error: unknown): string {
  return error instanceof DomainError ? error.code.toLowerCase() : 'error';
}

/** `reservations` that count and time every reserve (`fd_reserve_total`, `fd_reserve_duration_seconds`). */
export function instrumentReservations(service: ReservationService): ReservationService {
  return {
    async reserve(request, log) {
      const stop = reserveDuration.startTimer();
      let result = 'error';
      try {
        const reserved = await service.reserve(request, log);
        result = reserved.replayed ? 'replayed' : 'created';
        return reserved;
      } catch (error) {
        result = failureResult(error);
        throw error;
      } finally {
        reserves.inc({ result });
        stop({ result });
      }
    },
  };
}

/** The reserve ports, with the Postgres transaction timed (`fd_pg_reserve_txn_seconds`), whatever its outcome. */
export function timeReserveTransaction(ports: ReservePorts): ReservePorts {
  return {
    ...ports,
    async record(reservation) {
      const stop = pgReserveTxn.startTimer();
      try {
        return await ports.record(reservation);
      } finally {
        stop();
      }
    },
  };
}

export function countAdminRebuild(): void {
  rebuilds.inc({ reason: 'admin' });
}

/** A socket the gateway serves from now on; `wsSocketClosed` exactly once when it detaches. */
export function wsSocketOpened(): void {
  wsSockets.inc();
}

export function wsSocketClosed(): void {
  wsSockets.dec();
}

export function countWsFrame(): void {
  wsFramesSent.inc();
}

/** Node's own process metrics (CPU, memory, event loop, GC) beside ours; once per process (main.ts). */
export function collectProcessMetrics(): void {
  collectDefaultMetrics({ register: registry });
}

/** `GET /metrics` in the Prometheus text format, mounted for every `API_ROLES`. */
export function metricsRoute(app: Api): void {
  app.get(METRICS_PATH, async (_request, reply) => {
    reply.header('content-type', registry.contentType).header('cache-control', 'no-store');
    return registry.metrics();
  });
}
