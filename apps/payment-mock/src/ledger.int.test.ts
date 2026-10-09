import { randomUUID } from 'node:crypto';
import { pgErrorOf, sql } from '@flashdrop/db';
import { waitForLockWaiters } from '@flashdrop/db/testing';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChargeCommand, ChargeResult } from './ledger';
import { createPspTestDatabase, type PspTestDatabase } from './test/database';

/*
 * The ledger against Postgres, connected as the psp role (design §6.5): idempotency, the close fence, the
 * strict order of a charge and a close of one reference, and what the role may do.
 */

let psp: PspTestDatabase;
beforeAll(async () => {
  psp = await createPspTestDatabase();
});
afterAll(() => psp?.close());

const reference = () => randomUUID();

function charge(ref: string, overrides: Partial<ChargeCommand> = {}): ChargeCommand {
  return {
    reference: ref,
    amountCents: 2_998,
    paymentMethod: 'pm_ok',
    idempotencyKey: `charge:${ref}`,
    ...overrides,
  };
}

function createdId(result: ChargeResult): string {
  if (result.kind !== 'created' || result.response.status === 'reference_closed') {
    throw new Error(`expected a created charge, got ${JSON.stringify(result)}`);
  }
  return result.response.id;
}

async function rows(ref: string) {
  return psp.ledger.chargesFor(ref);
}

describe('charge idempotency', () => {
  it('records one charge per key and replays the original result', async () => {
    const ref = reference();
    const first = await psp.ledger.charge(charge(ref));
    const id = createdId(first);
    expect(first.kind === 'created' && first.response).toEqual({ status: 'succeeded', id });

    const again = await psp.ledger.charge(charge(ref));
    expect(again).toEqual({ kind: 'replayed', response: { status: 'succeeded', id } });
    expect(await rows(ref)).toMatchObject([{ id, status: 'succeeded', amountCents: 2_998 }]);
  });

  it('refuses a key reused for a different request, recording nothing', async () => {
    const ref = reference();
    await psp.ledger.charge(charge(ref));
    expect(await psp.ledger.charge(charge(ref, { amountCents: 1 }))).toEqual({ kind: 'key_reused' });
    expect(await psp.ledger.charge(charge(ref, { paymentMethod: 'pm_slow' }))).toEqual({
      kind: 'key_reused',
    });
    const other = reference();
    expect(await psp.ledger.charge(charge(other, { idempotencyKey: `charge:${ref}` }))).toEqual({
      kind: 'key_reused',
    });
    expect(await rows(ref)).toHaveLength(1);
    expect(await rows(other)).toEqual([]);
  });

  it('records a decline and replays it with its decline code', async () => {
    const ref = reference();
    const first = await psp.ledger.charge(charge(ref, { paymentMethod: 'pm_decline' }));
    const id = createdId(first);
    expect(first.kind === 'created' && first.response).toEqual({
      status: 'declined',
      id,
      declineCode: 'card_declined',
    });
    expect(await psp.ledger.charge(charge(ref, { paymentMethod: 'pm_decline' }))).toEqual({
      kind: 'replayed',
      response: { status: 'declined', id, declineCode: 'card_declined' },
    });
    expect(await rows(ref)).toMatchObject([{ id, status: 'declined', declineCode: 'card_declined' }]);
  });

  it('gives 20 concurrent identical charges one charge and one answer', async () => {
    const ref = reference();
    const results = await Promise.all(Array.from({ length: 20 }, () => psp.ledger.charge(charge(ref))));
    const created = results.filter((result) => result.kind === 'created');
    expect(created).toHaveLength(1);
    const id = createdId(created[0] as ChargeResult);
    for (const result of results) {
      expect(result).toEqual({
        kind: expect.stringMatching(/^(created|replayed)$/),
        response: { status: 'succeeded', id },
      });
    }
    expect(await rows(ref)).toHaveLength(1);
  });

  it('binds a key to the first of two references charging it at once', async () => {
    const key = `charge:${randomUUID()}`;
    const [a, b] = [reference(), reference()];
    const results = await Promise.all([
      psp.ledger.charge(charge(a, { idempotencyKey: key })),
      psp.ledger.charge(charge(b, { idempotencyKey: key })),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['created', 'key_reused']);
    expect((await rows(a)).length + (await rows(b)).length).toBe(1);
  });
});

describe('close-by-reference', () => {
  it('fences a reference closed before any charge: later charges are refused and record nothing', async () => {
    const ref = reference();
    expect(await psp.ledger.close(ref)).toEqual([]);
    const fenced = {
      kind: 'fenced',
      response: { status: 'reference_closed', declineCode: 'reference_closed' },
    };
    expect(await psp.ledger.charge(charge(ref))).toEqual(fenced);
    // A retry, and any other key, get the same answer: closing is permanent.
    expect(await psp.ledger.charge(charge(ref))).toEqual(fenced);
    expect(await psp.ledger.charge(charge(ref, { idempotencyKey: `other:${ref}` }))).toEqual(fenced);
    expect(await rows(ref)).toEqual([]);
  });

  it('refunds a charge made before the close, and replays both answers unchanged', async () => {
    const ref = reference();
    const id = createdId(await psp.ledger.charge(charge(ref)));

    const refund = [{ chargeId: id, amountCents: 2_998 }];
    expect(await psp.ledger.close(ref)).toEqual(refund);
    expect(await psp.ledger.close(ref)).toEqual(refund);
    // The charge's replay is its original answer, as an idempotent replay must be.
    expect(await psp.ledger.charge(charge(ref))).toEqual({
      kind: 'replayed',
      response: { status: 'succeeded', id },
    });
    // A new key on the closed reference is fenced.
    expect((await psp.ledger.charge(charge(ref, { idempotencyKey: `late:${ref}` }))).kind).toBe('fenced');
    const [row] = await rows(ref);
    expect(row).toMatchObject({ id, status: 'refunded', refundedAt: expect.any(String) });
    expect(await rows(ref)).toHaveLength(1);
  });

  it('refunds nothing for a declined charge', async () => {
    const ref = reference();
    await psp.ledger.charge(charge(ref, { paymentMethod: 'pm_decline' }));
    expect(await psp.ledger.close(ref)).toEqual([]);
    expect(await rows(ref)).toMatchObject([{ status: 'declined', refundedAt: null }]);
  });

  it('refunds every succeeded charge of a reference charged under two keys', async () => {
    const ref = reference();
    const first = createdId(await psp.ledger.charge(charge(ref)));
    const second = createdId(await psp.ledger.charge(charge(ref, { idempotencyKey: `second:${ref}` })));
    expect((await psp.ledger.close(ref)).map((refund) => refund.chargeId).sort()).toEqual(
      [first, second].sort(),
    );
    expect((await rows(ref)).every((row) => row.status === 'refunded')).toBe(true);
  });
});

describe('a charge and a close of one reference are strictly ordered', () => {
  /** Holds the reference's row lock from the owner role, so the next callers queue in a known order. */
  async function lockReference(ref: string): Promise<pg.PoolClient> {
    await psp.admin.db.execute(sql`INSERT INTO psp."references" (reference) VALUES (${ref})`);
    const client = await psp.admin.pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM psp."references" WHERE reference = $1 FOR UPDATE', [ref]);
    return client;
  }

  async function release(client: pg.PoolClient): Promise<void> {
    await client.query('ROLLBACK');
    client.release();
  }

  it('a charge in flight when the close arrives commits first and is refunded', async () => {
    const ref = reference();
    const holder = await lockReference(ref);
    const charging = psp.ledger.charge(charge(ref));
    await waitForLockWaiters(psp.admin.pool, 1);
    const closing = psp.ledger.close(ref);
    await waitForLockWaiters(psp.admin.pool, 2);
    await release(holder);

    const id = createdId(await charging);
    expect(await closing).toEqual([{ chargeId: id, amountCents: 2_998 }]);
    expect(await rows(ref)).toMatchObject([{ id, status: 'refunded' }]);
  });

  it('a charge arriving while the close is in flight is refused', async () => {
    const ref = reference();
    const holder = await lockReference(ref);
    const closing = psp.ledger.close(ref);
    await waitForLockWaiters(psp.admin.pool, 1);
    const charging = psp.ledger.charge(charge(ref));
    await waitForLockWaiters(psp.admin.pool, 2);
    await release(holder);

    expect(await closing).toEqual([]);
    expect((await charging).kind).toBe('fenced');
    expect(await rows(ref)).toEqual([]);
  });

  it('never leaves a succeeded charge on a closed reference when 50 of each race', async () => {
    const refs = Array.from({ length: 50 }, reference);
    const outcomes = await Promise.all(
      refs.map(async (ref) => {
        const [charged, refunds] = await Promise.all([psp.ledger.charge(charge(ref)), psp.ledger.close(ref)]);
        return { ref, charged, refunds };
      }),
    );
    for (const { ref, charged, refunds } of outcomes) {
      if (charged.kind === 'created') {
        expect(refunds).toEqual([{ chargeId: createdId(charged), amountCents: 2_998 }]);
        expect(await rows(ref)).toMatchObject([{ status: 'refunded' }]);
      } else {
        expect(charged.kind).toBe('fenced');
        expect(refunds).toEqual([]);
        expect(await rows(ref)).toEqual([]);
      }
    }
    const { rows: orphans } = await psp.admin.pool.query(
      `SELECT c.id FROM psp.charges c JOIN psp."references" r USING (reference)
       WHERE r.closed_at IS NOT NULL AND c.status = 'succeeded'`,
    );
    expect(orphans).toEqual([]);
  });
});

describe('the psp role', () => {
  it('cannot read FlashDrop tables or delete ledger rows', async () => {
    const denied = async (statement: string) => {
      const error = await psp.pool.query(statement).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      return pgErrorOf(error)?.code;
    };
    expect(await denied('SELECT 1 FROM public.orders LIMIT 1')).toBe('42501');
    expect(await denied('DELETE FROM psp.charges')).toBe('42501');
    expect(await denied('DELETE FROM psp."references"')).toBe('42501');
  });
});
