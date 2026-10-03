import { randomUUID } from 'node:crypto';
import { DomainError, NotFoundError, ValidationError } from '@flashdrop/domain';
import { fingerprintHex } from '@flashdrop/domain/identity';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './client';
import {
  applyDropAction,
  applyDueDropTransition,
  createDraftDrop,
  type DropSettings,
  getAdminDrop,
  isPastRetention,
  isTrackedDrop,
  listDropSchedule,
  listTrackedDrops,
  patchDraftDrop,
  readRebuildSnapshot,
} from './drops';
import { pgErrorOf } from './errors';
import { getOrder } from './orders';
import { drops, products, users } from './schema';
import { createTestDatabase, type TestDatabase } from './test-database';
import { createDrop, createUsers, reservation } from './test-fixtures';
import { createTestBuyers, createTestDrop } from './test-support';
import { fenceRedisGeneration, insertRejectedTombstone, recordReservation } from './transitions';

let test: TestDatabase;
let db: Db;

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.db;
});

afterAll(async () => {
  await test?.drop();
});

async function newProduct(): Promise<string> {
  const id = randomUUID();
  await db.insert(products).values({
    id,
    slug: `p-${id}`,
    title: 'Admin test product',
    description: 'Exists only in this test database.',
    imageKeys: [],
    status: 'PUBLISHED',
  });
  return id;
}

const HOUR = 3_600_000;

async function settings(patch: Partial<DropSettings> = {}): Promise<DropSettings> {
  return {
    productId: await newProduct(),
    roomId: null,
    startsAt: new Date(Date.now() + HOUR),
    endsAt: new Date(Date.now() + 2 * HOUR),
    priceCents: 4900,
    currency: 'USD',
    perUserLimit: 2,
    holdSeconds: 120,
    paymentSeconds: 300,
    stock: 50,
    ...patch,
  };
}

/** Sets a drop's window relative to now, in seconds, bypassing the DRAFT-only rule like time itself does. */
async function moveWindow(dropId: string, startsIn: number, endsIn: number): Promise<void> {
  await db
    .update(drops)
    .set({
      startsAt: sql`now() + make_interval(secs => ${startsIn})`,
      endsAt: sql`now() + make_interval(secs => ${endsIn})`,
    })
    .where(eq(drops.id, dropId));
}

describe('drop administration (§4.7, §5.1)', () => {
  it('creates a DRAFT drop with its inventory', async () => {
    const input = await settings();

    const created = await createDraftDrop(db, input);

    expect(created.drop).toMatchObject({ status: 'DRAFT', productId: input.productId, priceCents: 4900 });
    expect(created.inventory).toEqual({ total: 50, reserved: 0, sold: 0, redisGen: 0 });
    expect(await getAdminDrop(db, created.drop.id)).toEqual(created);
  });

  it('patches only DRAFT drops, and checks the window against the stored one', async () => {
    const { drop } = await createDraftDrop(db, await settings());

    const patched = await patchDraftDrop(db, drop.id, { stock: 80, perUserLimit: 3 });
    expect(patched.inventory.total).toBe(80);
    expect(patched.drop.perUserLimit).toBe(3);

    await expect(patchDraftDrop(db, drop.id, { endsAt: new Date(Date.now()) })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(patchDraftDrop(db, randomUUID(), { stock: 1 })).rejects.toBeInstanceOf(NotFoundError);

    await applyDropAction(db, drop.id, 'arm');
    await expect(patchDraftDrop(db, drop.id, { stock: 1 })).rejects.toMatchObject({ code: 'DROP_ARMED' });
    expect((await getAdminDrop(db, drop.id))?.inventory.total).toBe(80);
  });

  it('arms once, and never two open drops of one product', async () => {
    const input = await settings();
    const first = await createDraftDrop(db, input);
    const second = await createDraftDrop(db, input);

    expect(await applyDropAction(db, first.drop.id, 'arm')).toEqual({ from: 'DRAFT', to: 'SCHEDULED' });
    await expect(applyDropAction(db, first.drop.id, 'arm')).rejects.toMatchObject({ code: 'DROP_ARMED' });
    const conflict = applyDropAction(db, second.drop.id, 'arm');
    await expect(conflict).rejects.toBeInstanceOf(DomainError);
    await expect(conflict).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(applyDropAction(db, randomUUID(), 'pause')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('pauses, resumes to the status the clock implies, and ends', async () => {
    const { drop } = await createDraftDrop(db, await settings());
    await applyDropAction(db, drop.id, 'arm');

    expect(await applyDropAction(db, drop.id, 'pause')).toEqual({ from: 'SCHEDULED', to: 'PAUSED' });
    expect(await applyDropAction(db, drop.id, 'resume')).toEqual({ from: 'PAUSED', to: 'SCHEDULED' });
    await moveWindow(drop.id, -60, 3600);
    await applyDropAction(db, drop.id, 'pause');
    expect(await applyDropAction(db, drop.id, 'resume')).toEqual({ from: 'PAUSED', to: 'LIVE' });
    await applyDropAction(db, drop.id, 'pause');
    await moveWindow(drop.id, -120, -60);
    expect(await applyDropAction(db, drop.id, 'resume')).toEqual({ from: 'PAUSED', to: 'ENDED' });
    await expect(applyDropAction(db, drop.id, 'pause')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(applyDropAction(db, drop.id, 'end')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('applies the scheduler transitions that are due, and nothing else', async () => {
    const { drop } = await createDraftDrop(db, await settings());
    expect(await applyDueDropTransition(db, drop.id)).toBeUndefined(); // DRAFT is never scheduled
    await applyDropAction(db, drop.id, 'arm');
    expect(await applyDueDropTransition(db, drop.id)).toBeUndefined(); // not yet

    await moveWindow(drop.id, -1, 3600);
    expect(await applyDueDropTransition(db, drop.id)).toEqual({ from: 'SCHEDULED', to: 'LIVE' });
    expect(await applyDueDropTransition(db, drop.id)).toBeUndefined();
    await moveWindow(drop.id, -3600, -1);
    expect(await applyDueDropTransition(db, drop.id)).toEqual({ from: 'LIVE', to: 'ENDED' });

    // A scheduler that was down for the whole window ends the drop in one step.
    const missed = await createDraftDrop(db, await settings());
    await applyDropAction(db, missed.drop.id, 'arm');
    await moveWindow(missed.drop.id, -7200, -3600);
    expect(await applyDueDropTransition(db, missed.drop.id)).toEqual({ from: 'SCHEDULED', to: 'ENDED' });
  });

  it('lists the schedule with the due flag Postgres computes, without locking anything', async () => {
    const due = await createDrop(db, { status: 'SCHEDULED', startsIn: -1 });
    const notYet = await createDrop(db, { status: 'SCHEDULED', startsIn: 60 });
    const over = await createDrop(db, { status: 'PAUSED', startsIn: -60, endsIn: -1 });
    const live = await createDrop(db, { status: 'LIVE' });

    const schedule = new Map((await listDropSchedule(db)).map((d) => [d.id, d]));

    expect(schedule.get(due.dropId)).toEqual({ id: due.dropId, status: 'SCHEDULED', transitionDue: true });
    expect(schedule.get(notYet.dropId)?.transitionDue).toBe(false);
    expect(schedule.get(over.dropId)?.transitionDue).toBe(true);
    expect(schedule.get(live.dropId)?.transitionDue).toBe(false);
  });

  // Regression: both CTEs took FOR UPDATE, which conflicts with the FOR KEY SHARE that every in-flight
  // reserve holds on the drops row through its foreign keys, so a hot drop could be neither paused nor ended.
  it('changes the status of a drop while reserve transactions hold its row for their foreign keys', async () => {
    const { dropId } = await createDrop(db, { status: 'LIVE' });
    const [userId] = await createUsers(db, 1);
    const reserving = await test.pool.connect();
    try {
      await reserving.query('BEGIN');
      // What the reserve transaction's quota upsert does before it commits: FOR KEY SHARE on the drop.
      await reserving.query(
        `INSERT INTO user_drop_quota (user_id, drop_id, claimed, limit_qty) VALUES ($1, $2, 1, 2)`,
        [userId, dropId],
      );

      expect(await within(2_000, applyDropAction(db, dropId, 'pause'))).toEqual({
        from: 'LIVE',
        to: 'PAUSED',
      });
      await moveWindow(dropId, -3600, -1);
      expect(await within(2_000, applyDueDropTransition(db, dropId))).toEqual({
        from: 'PAUSED',
        to: 'ENDED',
      });
      await reserving.query('COMMIT');
    } finally {
      reserving.release();
    }
  });

  it('gives up on a drops row another writer holds after its lock timeout, so the scheduler skips it', async () => {
    const { dropId } = await createDrop(db, { status: 'SCHEDULED', startsIn: -1 });
    const writer = await test.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT 1 FROM drops WHERE id = $1 FOR NO KEY UPDATE', [dropId]);

      const started = Date.now();
      const busy = await applyDueDropTransition(db, dropId).catch((error: unknown) => error);
      expect(pgErrorOf(busy)?.code).toBe('55P03');
      expect(Date.now() - started).toBeLessThan(5_000);
      await writer.query('ROLLBACK');
    } finally {
      writer.release();
    }
    expect(await applyDueDropTransition(db, dropId)).toEqual({ from: 'SCHEDULED', to: 'LIVE' });
  });
});

/** `promise`, or a rejection if it is still pending after `ms`: a statement blocked on a row lock. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const blocked = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still blocked after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, blocked]);
  } finally {
    clearTimeout(timer);
  }
}

describe('the tracked set (§4.1)', () => {
  it('holds armed drops until 24 h after they end, and isPastRetention is its exact complement', async () => {
    const draft = await createDraftDrop(db, await settings());
    const live = await createDrop(db, { status: 'LIVE' });
    const endedRecently = await createDrop(db, { status: 'ENDED', startsIn: -24 * 3600, endsIn: -23 * 3600 });
    const endedLongAgo = await createDrop(db, { status: 'ENDED', startsIn: -90_000, endsIn: -86_401 });

    const tracked = new Set((await listTrackedDrops(db)).map((d) => d.id));

    for (const [dropId, expected] of [
      [draft.drop.id, false],
      [live.dropId, true],
      [endedRecently.dropId, true],
      [endedLongAgo.dropId, false],
    ] as const) {
      expect(tracked.has(dropId), dropId).toBe(expected);
      expect(await isTrackedDrop(db, dropId)).toBe(expected);
    }
    expect(await isPastRetention(db, live.dropId)).toBe(false);
    expect(await isPastRetention(db, endedRecently.dropId)).toBe(false);
    expect(await isPastRetention(db, endedLongAgo.dropId)).toBe(true);
    expect(await isPastRetention(db, draft.drop.id)).toBe(false);
  });
});

describe('readRebuildSnapshot (§4.7 step 3)', () => {
  it('reads the fenced generation, counters, quotas and every order in the fd_rebuild shape', async () => {
    const { dropId, productId } = await createDrop(db, { total: 10, perUserLimit: 4, holdSeconds: 60 });
    const [a = '', b = ''] = await createUsers(db, 2);
    const held = reservation(a, dropId, 1);
    const placed = reservation(a, dropId, 2);
    const paid = reservation(b, dropId, 1);
    const expired = reservation(b, dropId, 1);
    for (const r of [held, placed, paid, expired]) await recordReservation(db, { ...r, gen: 0 });
    const rejected = reservation(b, dropId, 3);
    await insertRejectedTombstone(db, { ...rejected, reason: 'SOLD_OUT' });
    // Move orders along the §4.4 edges with their counters, as the real transitions do.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE orders SET status = 'PENDING_PAYMENT', version = 2 WHERE id IN (${placed.id}, ${paid.id})`,
      );
      await tx.execute(
        sql`UPDATE orders SET status = 'PAID', paid_at = now(), version = 3 WHERE id = ${paid.id}`,
      );
      await tx.execute(
        sql`UPDATE drop_inventory SET reserved = reserved - 1, sold = sold + 1 WHERE drop_id = ${dropId}`,
      );
      await tx.execute(sql`
        UPDATE orders SET status = 'EXPIRED', close_reason = 'TIMEOUT', closed_at = now(), version = 2
        WHERE id = ${expired.id}`);
      await tx.execute(sql`UPDATE drop_inventory SET reserved = reserved - 1 WHERE drop_id = ${dropId}`);
      await tx.execute(
        sql`UPDATE user_drop_quota SET claimed = claimed - 1 WHERE user_id = ${b} AND drop_id = ${dropId}`,
      );
    });
    expect(await fenceRedisGeneration(db, dropId)).toBe(1);

    const snapshot = await readRebuildSnapshot(db, dropId);

    const [drop] = await db.select().from(drops).where(eq(drops.id, dropId));
    if (snapshot === undefined || drop === undefined) throw new Error('missing');
    expect(snapshot).toMatchObject({ gen: 1, total: 10, reserved: 3, sold: 1 });
    expect(snapshot.quotas).toEqual({ [a]: 3, [b]: 1 });
    expect(snapshot.meta).toEqual({
      status: 'LIVE',
      startsAt: expect.any(Number),
      endsAt: drop.endsAt.getTime(),
      holdMs: 60_000,
      limit: 4,
      retainAt: drop.endsAt.getTime() + 86_400_000,
      productId,
    });
    // Rounded inwards to whole ms (start up, end down), so Lua's window is never wider than Postgres's. The
    // Date read through the builder is truncated, so the start is that or 1 ms later.
    expect(snapshot.meta.startsAt - drop.startsAt.getTime()).toBeGreaterThanOrEqual(0);
    expect(snapshot.meta.startsAt - drop.startsAt.getTime()).toBeLessThanOrEqual(1);
    const byRid = new Map(snapshot.entries.map((e) => [e.rid, e]));
    expect(byRid.size).toBe(5);
    for (const [r, state] of [
      [held, 'HELD'],
      [placed, 'HELD'],
      [paid, 'COMMITTED'],
      [expired, 'RELEASED'],
      [rejected, 'RELEASED'],
    ] as const) {
      const order = await getOrder(db, r.id);
      expect(byRid.get(r.id)).toEqual({
        rid: r.id,
        u: r.userId,
        q: r.qty,
        s: state,
        fp: fingerprintHex(r.requestHash),
        k: r.idempotencyKey,
        expAt: expect.any(Number),
      });
      const expAt = byRid.get(r.id)?.expAt ?? 0;
      expect(expAt - (order?.expiresAt.getTime() ?? 0)).toBeGreaterThanOrEqual(0);
      expect(expAt - (order?.expiresAt.getTime() ?? 0)).toBeLessThanOrEqual(1);
    }
    // The snapshot is plain JSON: exactly what fd_rebuild receives.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('has nothing for an unknown or DRAFT drop', async () => {
    const draft = await createDraftDrop(db, await settings());

    expect(await readRebuildSnapshot(db, randomUUID())).toBeUndefined();
    expect(await readRebuildSnapshot(db, draft.drop.id)).toBeUndefined();
    expect(await fenceRedisGeneration(db, randomUUID())).toBeUndefined();
  });
});

describe('test route support (§13)', () => {
  it('creates an isolated DRAFT drop starting now, ready to arm', async () => {
    const created = await createTestDrop(db, {
      stock: 7,
      perUserLimit: 2,
      holdSeconds: 10,
      paymentSeconds: 30,
      durationSeconds: 600,
      priceCents: 2500,
    });

    expect(created.endsAt.getTime() - created.startsAt.getTime()).toBe(600_000);
    expect(Math.abs(created.startsAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(await getAdminDrop(db, created.dropId)).toMatchObject({
      drop: {
        status: 'DRAFT',
        productId: created.productId,
        holdSeconds: 10,
        paymentSeconds: 30,
        priceCents: 2500,
      },
      inventory: { total: 7, reserved: 0, sold: 0, redisGen: 0 },
    });
    const [product] = await db.select().from(products).where(eq(products.id, created.productId));
    expect(product).toMatchObject({ slug: created.productSlug, status: 'PUBLISHED' });

    const at = new Date(Date.now() + HOUR);
    const later = await createTestDrop(db, {
      stock: 1,
      perUserLimit: 1,
      holdSeconds: 10,
      paymentSeconds: 10,
      startsAt: at,
      durationSeconds: 60,
      priceCents: 100,
    });
    expect(later.startsAt).toEqual(at);
    expect(await applyDropAction(db, later.dropId, 'arm')).toEqual({ from: 'DRAFT', to: 'SCHEDULED' });
  });

  it('creates buyers in bulk', async () => {
    const buyers = await createTestBuyers(db, 250);

    expect(buyers).toHaveLength(250);
    expect(new Set(buyers.map((b) => b.id)).size).toBe(250);
    const [first] = buyers;
    expect(first).toMatchObject({ role: 'buyer', email: `load-${first?.id}@load.test` });
    const stored = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.role, 'buyer'), sql`${users.email} LIKE 'load-%@load.test'`));
    expect(stored[0]?.n).toBeGreaterThanOrEqual(250);
  });
});
