import { z } from 'zod';
import { HoldSeconds, PaymentSeconds, PerUserLimit } from './admin';
import { Cents, IsoDateTime, Slug, Uuid } from './common';

/*
 * Test-only routes (design §5.1, §13): bulk session minting for k6 and an isolated, armed drop per
 * Playwright spec. They exist only with `ENABLE_TEST_ROUTES=true`, and every call must carry the
 * `x-test-secret` header.
 */

export const TEST_SECRET_HEADER = 'x-test-secret';

/** `POST /api/v1/test/sessions`: creates `count` fresh buyers and signs a session for each. */
export const TestSessionsBody = z.object({ count: z.int().min(1).max(10_000) });
export type TestSessionsBody = z.infer<typeof TestSessionsBody>;

export const TestSession = z.object({
  userId: Uuid,
  /** The value of the `fd_session` cookie. */
  token: z.string().min(1),
});
export type TestSession = z.infer<typeof TestSession>;

export const TestSessionsResponse = z.object({ sessions: z.array(TestSession) });
export type TestSessionsResponse = z.infer<typeof TestSessionsResponse>;

/**
 * `POST /api/v1/test/drops`: a new PUBLISHED product and a drop of it, armed (SCHEDULED, with its Redis
 * state built) before the response, so no spec shares stock with another.
 */
export const TestDropBody = z.object({
  stock: z.int().min(1).max(100_000),
  perUserLimit: PerUserLimit,
  holdSeconds: HoldSeconds,
  paymentSeconds: PaymentSeconds,
  /** Defaults to the server's now, so the drop is open at once. */
  startsAt: IsoDateTime.optional(),
  /**
   * Defaults to 30 minutes, longer than any spec or load run. A test drop is never ended by hand, so its
   * window alone decides when it stops selling and when it leaves the tracked set (its end + 24 h, §4.1)
   * that the background loops iterate on a shared stack.
   */
  durationSeconds: z
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .default(30 * 60),
  priceCents: Cents.default(2_500),
  /**
   * Gives the drop a live room of its own, pinned to it and playing the local sample stream, for the live
   * room spec (§13). Like test products, test rooms are reachable by URL but never listed.
   */
  room: z.boolean().optional(),
});
export type TestDropBody = z.output<typeof TestDropBody>;

export const TestDropResponse = z.object({
  dropId: Uuid,
  productId: Uuid,
  productSlug: Slug,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  /** The drop's own room (`room: true`), else null. */
  room: z.object({ id: Uuid, slug: Slug }).nullable(),
});
export type TestDropResponse = z.infer<typeof TestDropResponse>;
