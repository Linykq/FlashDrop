import type { Logger } from '@flashdrop/config';
import type { OrderView } from '@flashdrop/contracts';
import {
  type Db,
  getOrderForUser,
  insertRejectedTombstone,
  isTrackedDrop,
  isUnknownUserError,
  type NewReservation,
  type OrderWithProduct,
  type RejectedTombstone,
  type ReservationOutcome,
  recordReservation,
  toOrderView,
} from '@flashdrop/db';
import {
  alert,
  BugError,
  DomainError,
  type ErrorCode,
  LUA_TO_API,
  RetryError,
  reserveReplay,
} from '@flashdrop/domain';
import { requestFingerprint, reservationId } from '@flashdrop/domain/identity';
import {
  type FlashdropRedis,
  fdReserve,
  type ReserveInput,
  type ReserveResult,
  type SyncNudger,
} from '@flashdrop/inventory';
import type { PgBreaker } from './pg-breaker';

/*
 * `POST /drops/:dropId/reservations` (design §4.5, §5.2): Redis admits, Postgres decides.
 *
 *   1. `fd_reserve` checks the window, the per-user limit and the stock and takes a hold, atomically with
 *      its idempotency record (`rsv[rid]`). Losers end here after one read-only call.
 *   2. The winner's Postgres transaction records the order under the generation Lua admitted it with
 *      (`recordReservation`: order, quota, outbox, then the hot inventory row last).
 *   3. A rid that already has an order is a replay, answered with the order's current representation.
 *
 * Ordering rule (§4.3): Redis takes stock first and gives it back only after Postgres committed an outcome.
 * So a refusal by Postgres never touches Redis here: it writes the REJECTED tombstone, and the settle safety
 * net releases the hold once it sees that terminal row. A STALE_GEN refusal needs no release at all: the
 * rebuild that fenced the generation replaced the whole `rsv` hash without this hold.
 */

export interface ReserveRequest {
  readonly userId: string;
  readonly dropId: string;
  readonly idempotencyKey: string;
  readonly qty: number;
  readonly traceId: string;
}

export interface Reserved {
  /** False for a new reservation (201), true when an existing order answers the request (200). */
  readonly replayed: boolean;
  readonly order: OrderView;
}

export interface ReservationService {
  /** Throws a `DomainError` for every refusal (409, 410, 422, 503 `RETRY`). */
  reserve(request: ReserveRequest, log: Pick<Logger, 'error' | 'warn'>): Promise<Reserved>;
}

/** What `reserve` needs from Redis and Postgres; the integration tests run it against the real ones. */
export interface ReservePorts {
  /** The Postgres breaker: false while no hold may be taken, because Postgres could not record it. */
  postgresHealthy(): boolean;
  admit(input: ReserveInput): Promise<ReserveResult>;
  record(
    reservation: NewReservation & { readonly gen: number; readonly traceId: string },
  ): Promise<ReservationOutcome>;
  tombstone(tombstone: RejectedTombstone): Promise<boolean>;
  /** The order `orderId` if it belongs to `userId`. A rid embeds its user, so for a rid that is any order. */
  findOrder(orderId: string, userId: string): Promise<OrderWithProduct | undefined>;
  isTracked(dropId: string): Promise<boolean>;
  /** `NOTIFY fd_sync`, debounced per drop; never rejects. */
  nudge(dropId: string): Promise<void>;
}

const MESSAGES: Readonly<Partial<Record<ErrorCode, string>>> = {
  SOLD_OUT: 'This drop is sold out',
  LIMIT_REACHED: 'You have reached the purchase limit for this drop',
  DROP_NOT_LIVE: 'This drop is not open',
  RESERVATION_EXPIRED: 'This reservation has expired',
  IDEMPOTENCY_KEY_REUSED: 'This Idempotency-Key was already used for a different request',
};

function refusal(code: ErrorCode): DomainError {
  return new DomainError(code, MESSAGES[code]);
}

const REBUILDING = 'The drop is being rebuilt, retry with the same Idempotency-Key';

export function createReservationService(ports: ReservePorts, now: () => Date): ReservationService {
  /** §4.5 replay: 200 with the current order, or its refusal (409, 410 when expired, 422 for another body). */
  function replay(found: OrderWithProduct | undefined, rid: string, fingerprint: Buffer): Reserved {
    // Callers replay only a rid whose row exists: the insert conflicted with it, or a tombstone insert did.
    if (found === undefined) throw new BugError(`no order ${rid} to replay`);
    const decision = reserveReplay(found.order, fingerprint);
    if (decision.kind === 'refused') throw refusal(decision.code);
    return { replayed: true, order: toOrderView(found.order, found.product, now()) };
  }

  return {
    async reserve(request, log) {
      // One canonical spelling of the drop id: the rid, the fingerprint and the Redis keys derive from it, so
      // a retry that spells the uuid in another case still lands on the same hold, order and body hash.
      const dropId = request.dropId.toLowerCase();
      const { userId, idempotencyKey, qty, traceId } = request;
      const fingerprint = requestFingerprint({ dropId, qty });
      const rid = reservationId({ userId, dropId, idempotencyKey });

      // Never create holds Postgres can't record.
      if (!ports.postgresHealthy()) throw new RetryError('Temporarily unavailable, retry');

      const admitted = await ports.admit({ dropId, rid, userId, qty, fingerprint, idempotencyKey });
      switch (admitted.kind) {
        case 'RETRY':
          throw new RetryError(REBUILDING);
        case 'NO_DROP': {
          // Not in Redis. A retry after retainAt, or after a wipe of an ended drop, still has its order.
          const found = await ports.findOrder(rid, userId);
          if (found !== undefined) return replay(found, rid, fingerprint);
          // Tracked: Redis was wiped and the rebuild is pending. Otherwise DRAFT, unknown, or long ended.
          if (await ports.isTracked(dropId)) {
            await ports.nudge(dropId);
            throw new RetryError(REBUILDING);
          }
          throw refusal('DROP_NOT_LIVE');
        }
        case 'FP_MISMATCH':
          throw refusal('IDEMPOTENCY_KEY_REUSED');
        case 'NOT_LIVE':
        case 'LIMIT':
        case 'SOLD_OUT':
          throw refusal(LUA_TO_API[admitted.kind]);
        case 'BAD_QTY':
          // Zod admits only 1..10, so this is a bug: 500, and the error handler alerts.
          throw new BugError('qty reached Lua unvalidated');
        case 'EXISTING': {
          // A double click or a retry: answer from the order when it exists, without a transaction. The
          // insert below would wait on the first copy's primary key while holding a pool connection, so
          // under a burst the copies of one click would starve the winners of connections.
          const found = await ports.findOrder(rid, userId);
          if (found !== undefined) return replay(found, rid, fingerprint);
          break;
        }
        case 'RESERVED':
          break;
      }

      // RESERVED (a new hold) or EXISTING (same key, same body) with no order yet: Postgres decides, fenced
      // by the generation Lua admitted under. EXISTING with no row is either the first copy still in flight
      // (the insert waits on its primary key, then replays it) or an orphan the API left by crashing after
      // Lua, which this insert heals.
      const reservation: NewReservation = {
        id: rid,
        userId,
        dropId,
        qty,
        idempotencyKey,
        requestHash: fingerprint,
      };
      const outcome = await ports
        .record({ ...reservation, gen: admitted.gen, traceId })
        .catch((error: unknown) => {
          // The session outlived its account (a reset development database, an old k6 token): the order's
          // user foreign key refuses it. The hold Lua took stays until orphan-scan finds that Postgres cannot
          // record it and rebuilds the drop (§4.6).
          if (isUnknownUserError(error)) {
            throw new DomainError('UNAUTHENTICATED', 'Your session has no account any more; sign in again', {
              cause: error,
            });
          }
          throw error;
        });
      if (outcome.kind === 'created') {
        return { replayed: false, order: toOrderView(outcome.order, outcome.product, now()) };
      }
      if (outcome.kind === 'replay') return replay(await ports.findOrder(rid, userId), rid, fingerprint);
      // The rebuild excluded this hold and dropped its rsv entry: retry with the same key starts clean.
      if (outcome.reason === 'STALE_GEN') throw new RetryError(REBUILDING);

      // One statement: the order.rejected event exists only if this tombstone won the rid. Against a
      // concurrent same-key request that committed RESERVED it inserts nothing, and the replay below
      // answers with that winner's order.
      await ports.tombstone({ ...reservation, reason: outcome.reason, traceId });
      if (outcome.reason !== 'NOT_LIVE') {
        // SOLD_OUT or LIMIT: Redis admitted what Postgres refused, so Redis was optimistic (§4.7).
        alert(
          log,
          'postgres_refusal',
          { dropId, orderId: rid, reason: outcome.reason },
          'postgres refused a redis admission; nudging the reconciler',
        );
        await ports.nudge(dropId);
      }
      return replay(await ports.findOrder(rid, userId), rid, fingerprint);
    },
  };
}

export interface ReservePortDeps {
  readonly db: Db;
  readonly redis: FlashdropRedis;
  readonly breaker: PgBreaker;
  readonly nudger: SyncNudger;
}

/** The real ports: node-redis Functions and the api pool, every Postgres call counted by the breaker. */
export function createReservePorts({ db, redis, breaker, nudger }: ReservePortDeps): ReservePorts {
  return {
    postgresHealthy: () => breaker.healthy(),
    admit: (input) => fdReserve(redis, input),
    record: (reservation) => breaker.run(() => recordReservation(db, reservation)),
    tombstone: (tombstone) => breaker.run(() => insertRejectedTombstone(db, tombstone)),
    findOrder: (orderId, userId) => breaker.run(() => getOrderForUser(db, orderId, userId)),
    isTracked: (dropId) => breaker.run(() => isTrackedDrop(db, dropId)),
    nudge: (dropId) => nudger.nudge(dropId),
  };
}
