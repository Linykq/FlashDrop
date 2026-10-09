import { describe, expect, it } from 'vitest';
import {
  byJudgingOrder,
  byJudgingOrderWithReturns,
  type CheckoutState,
  type IntentState,
  isRetryable,
  judgeCancel,
  judgeCheckout,
  judgePayment,
  judgeReserve,
  judgeStormAnswer,
  type OrderAnswer,
  pickFate,
  pickPaymentMethod,
  retryDelaySeconds,
} from './verdict';

const RID = '0192f0c4-1d2e-5a3b-8c4d-5e6f7a8b9c0d';
const OTHER = '0192f0c4-1d2e-5a3b-8c4d-000000000000';

function intent(overrides: Partial<IntentState> = {}): IntentState {
  return { sent: 1, uncertain: false, ...overrides };
}

const created: OrderAnswer = {
  status: 201,
  order: { id: RID, status: 'RESERVED', qty: 1 },
  replayed: false,
};
const replay: OrderAnswer = { status: 200, order: { id: RID, status: 'RESERVED', qty: 1 }, replayed: true };
const soldOut: OrderAnswer = { status: 409, replayed: false, code: 'SOLD_OUT' };

/** Judges the answers of one intent in the order the burst does, and returns the verdict kinds. */
function judgeAll(state: IntentState, answers: readonly OrderAnswer[]): string[] {
  return answers.map((answer) => {
    const verdict = judgeReserve(state, answer);
    return verdict.kind === 'replayed' ? `replayed${verdict.newOrder ? '+new' : ''}` : verdict.kind;
  });
}

describe('isRetryable', () => {
  it('retries a lost answer, RETRY and an edge without a healthy api with the same key', () => {
    for (const status of [0, 502, 503, 504]) expect(isRetryable(status)).toBe(true);
  });

  it('treats every answer the api decided as final', () => {
    for (const status of [200, 201, 400, 409, 410, 422, 429, 500]) expect(isRetryable(status)).toBe(false);
  });
});

describe('retryDelaySeconds', () => {
  it('follows Retry-After and falls back to 1 s', () => {
    expect(retryDelaySeconds('2')).toBe(2);
    expect(retryDelaySeconds(undefined)).toBe(1);
    expect(retryDelaySeconds('')).toBe(1);
    expect(retryDelaySeconds('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(1);
    expect(retryDelaySeconds('3600')).toBe(10);
  });
});

describe('judgeReserve', () => {
  it('counts a 201 as the creation and later replays of it as old news', () => {
    const state = intent();
    expect(judgeAll(state, [created])).toEqual(['created']);
    state.sent = 2;
    expect(judgeAll(state, [replay])).toEqual(['replayed']);
    expect(state.orderId).toBe(RID);
  });

  // Regression: a winner whose 201 was lost (k6 status 0 after its timeout) was retried, replayed with 200,
  // and never counted, so a correct run ended with units - 1 created and failed its gate.
  it('counts the order once when its 201 was lost and the retry replays it', () => {
    const state = intent({ sent: 2, uncertain: true });
    expect(judgeAll(state, [replay])).toEqual(['replayed+new']);
    expect(judgeAll(state, [replay])).toEqual(['replayed']);
  });

  it('flags a replay of an order no answer created when no send went unanswered', () => {
    expect(judgeAll(intent({ sent: 2 }), [replay])).toEqual(['mismatch']);
  });

  it('flags a replay on the first send, a second creation and a replay of another order', () => {
    expect(judgeAll(intent(), [replay])).toEqual(['mismatch']);
    expect(judgeAll(intent({ sent: 2 }), [created, created])).toEqual(['created', 'mismatch']);
    const other: OrderAnswer = { ...replay, order: { id: OTHER, status: 'RESERVED', qty: 1 } };
    expect(judgeAll(intent({ sent: 2 }), [created, other])).toEqual(['created', 'mismatch']);
  });

  it('flags a refusal of an order that exists', () => {
    expect(judgeAll(intent({ sent: 2 }), [created, soldOut])).toEqual(['created', 'mismatch']);
  });

  it('judges concurrent copies creation first, so the 201 names the order its twin replays', () => {
    const state = intent({ sent: 2 });
    expect(judgeAll(state, [replay, created].sort(byJudgingOrder))).toEqual(['created', 'replayed']);
    // With no stock coming back mid-run, a same-key pair answered with a creation and a refusal is wrong:
    // the refused copy ran first in Lua, so a unit came back in between, which reserve-only never does.
    expect(judgeAll(intent({ sent: 2 }), [soldOut, created].sort(byJudgingOrder))).toEqual([
      'created',
      'mismatch',
    ]);
    expect(judgeAll(intent({ sent: 2 }), [soldOut, soldOut])).toEqual(['sold-out', 'sold-out']);
  });

  it('accepts a refused copy before its twin creation when stock comes back mid-run', () => {
    expect(judgeAll(intent({ sent: 3 }), [replay, created, soldOut].sort(byJudgingOrderWithReturns))).toEqual(
      ['sold-out', 'created', 'replayed'],
    );
    // A refusal after the order exists is still wrong, however the copies are ordered.
    expect(judgeAll(intent({ sent: 2, orderId: RID }), [soldOut].sort(byJudgingOrderWithReturns))).toEqual([
      'mismatch',
    ]);
  });

  it('classifies refusals, expiry and rate limiting', () => {
    const limit: OrderAnswer = { status: 409, replayed: false, code: 'LIMIT_REACHED' };
    const notLive: OrderAnswer = { status: 409, replayed: false, code: 'DROP_NOT_LIVE' };
    expect(judgeAll(intent(), [soldOut, limit, notLive])).toEqual([
      'sold-out',
      'limit-reached',
      'unexpected',
    ]);
    expect(judgeAll(intent(), [{ status: 410, replayed: false }])).toEqual(['unexpected']);
    expect(judgeAll(intent({ orderId: RID }), [{ status: 410, replayed: false }])).toEqual(['expired']);
    expect(judgeAll(intent(), [{ status: 429, replayed: false }])).toEqual(['rate-limited']);
    expect(judgeAll(intent(), [{ status: 500, replayed: false }])).toEqual(['unexpected']);
  });
});

describe('judgeStormAnswer', () => {
  const expected = { rid: RID, qty: 1, changedBy: 201 } as const;

  it('accepts the creation and header-marked replays of the one order', () => {
    expect(judgeStormAnswer(expected, created)).toBe('changed');
    expect(judgeStormAnswer(expected, replay)).toBe('replayed');
  });

  it('accepts the one submission and its replays in the checkout storm, in any later status', () => {
    const checkout = { ...expected, changedBy: 202 } as const;
    const submitted: OrderAnswer = {
      status: 202,
      order: { id: RID, status: 'PENDING_PAYMENT', qty: 1 },
      replayed: false,
    };
    const paidReplay: OrderAnswer = {
      status: 200,
      order: { id: RID, status: 'PAID', qty: 1 },
      replayed: true,
    };
    expect(judgeStormAnswer(checkout, submitted)).toBe('changed');
    expect(judgeStormAnswer(checkout, paidReplay)).toBe('replayed');
    expect(judgeStormAnswer(checkout, created)).toBe('wrong');
    expect(judgeStormAnswer(checkout, { status: 409, replayed: false, code: 'ALREADY_SUBMITTED' })).toBe(
      'wrong',
    );
  });

  it('rejects another order, another qty, a replay without the header and any other status', () => {
    expect(judgeStormAnswer(expected, { ...created, order: { id: OTHER, status: 'RESERVED', qty: 1 } })).toBe(
      'wrong',
    );
    expect(judgeStormAnswer(expected, { ...created, order: { id: RID, status: 'RESERVED', qty: 2 } })).toBe(
      'wrong',
    );
    expect(judgeStormAnswer(expected, { ...replay, replayed: false })).toBe('wrong');
    expect(judgeStormAnswer(expected, soldOut)).toBe('wrong');
  });
});

describe('judgeCheckout', () => {
  const state = (overrides: Partial<CheckoutState> = {}): CheckoutState => ({
    sent: 1,
    uncertain: false,
    submitted: false,
    ...overrides,
  });
  const submitted: OrderAnswer = {
    status: 202,
    order: { id: RID, status: 'PENDING_PAYMENT', qty: 1 },
    replayed: false,
  };
  const replayed = (status: string): OrderAnswer => ({
    status: 200,
    order: { id: RID, status, qty: 1 },
    replayed: true,
  });
  const judgeAll = (s: CheckoutState, answers: readonly OrderAnswer[]) =>
    [...answers].sort(byJudgingOrder).map((answer) => {
      const verdict = judgeCheckout(s, RID, answer);
      return verdict.kind === 'replayed' ? `replayed${verdict.newSubmission ? '+new' : ''}` : verdict.kind;
    });

  it('accepts one 202 and replays of it in any later state, judged 202 first', () => {
    const storm = state({ sent: 3 });
    expect(judgeAll(storm, [replayed('PENDING_PAYMENT'), submitted, replayed('PAID')])).toEqual([
      'submitted',
      'replayed',
      'replayed',
    ]);
  });

  it('counts a submission whose 202 was lost once, through the retry that replays it', () => {
    const s = state({ sent: 2, uncertain: true });
    expect(judgeAll(s, [replayed('PENDING_PAYMENT')])).toEqual(['replayed+new']);
    expect(judgeAll(s, [replayed('PAID')])).toEqual(['replayed']);
  });

  it('flags a second 202, a replay nobody submitted, another key and expiry after submission', () => {
    expect(judgeAll(state({ sent: 2 }), [submitted, submitted])).toEqual(['submitted', 'mismatch']);
    expect(judgeAll(state({ sent: 2 }), [replayed('PENDING_PAYMENT')])).toEqual(['mismatch']);
    expect(judgeAll(state(), [{ status: 409, replayed: false, code: 'ALREADY_SUBMITTED' }])).toEqual([
      'mismatch',
    ]);
    expect(judgeAll(state({ sent: 2, submitted: true }), [{ status: 410, replayed: false }])).toEqual([
      'mismatch',
    ]);
    expect(judgeAll(state(), [{ status: 410, replayed: false, code: 'RESERVATION_EXPIRED' }])).toEqual([
      'expired',
    ]);
    expect(judgeAll(state(), [{ status: 500, replayed: false }])).toEqual(['unexpected']);
    const other: OrderAnswer = { ...submitted, order: { id: OTHER, status: 'PENDING_PAYMENT', qty: 1 } };
    expect(judgeAll(state(), [other])).toEqual(['mismatch']);
  });
});

describe('judgeCancel', () => {
  it('accepts the cancelled order and counts a conflict apart', () => {
    expect(
      judgeCancel(RID, { status: 200, order: { id: RID, status: 'CANCELLED', qty: 1 }, replayed: false }),
    ).toBe('cancelled');
    expect(judgeCancel(RID, { status: 409, replayed: false, code: 'CONFLICT' })).toBe('conflict');
    expect(
      judgeCancel(RID, { status: 200, order: { id: RID, status: 'RESERVED', qty: 1 }, replayed: false }),
    ).toBe('unexpected');
    expect(judgeCancel(RID, { status: 404, replayed: false, code: 'NOT_FOUND' })).toBe('unexpected');
  });
});

describe('judgePayment', () => {
  it('expects pm_ok to end PAID and pm_decline to end PAYMENT_FAILED', () => {
    expect(judgePayment('pm_ok', 'PAID')).toBe('as-expected');
    expect(judgePayment('pm_decline', 'PAYMENT_FAILED')).toBe('as-expected');
    expect(judgePayment('pm_ok', 'PAYMENT_FAILED')).toBe('wrong');
    expect(judgePayment('pm_ok', 'EXPIRED')).toBe('wrong');
    expect(judgePayment('pm_decline', 'PAID')).toBe('wrong');
  });
});

describe('pickFate and pickPaymentMethod', () => {
  it('splits winners 70/20/10 and checkouts 90/10 by the roll', () => {
    const shares = { checkout: 0.7, cancel: 0.2 };
    expect([0, 0.69, 0.7, 0.89, 0.9, 0.99].map((roll) => pickFate(roll, shares))).toEqual([
      'checkout',
      'checkout',
      'cancel',
      'cancel',
      'abandon',
      'abandon',
    ]);
    expect([0, 0.09, 0.1, 0.99].map((roll) => pickPaymentMethod(roll, 0.1))).toEqual([
      'pm_decline',
      'pm_decline',
      'pm_ok',
      'pm_ok',
    ]);
  });
});
