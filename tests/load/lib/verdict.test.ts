import { describe, expect, it } from 'vitest';
import {
  byJudgingOrder,
  type IntentState,
  isRetryable,
  judgeReserve,
  judgeStormAnswer,
  type ReserveAnswer,
  retryDelaySeconds,
} from './verdict';

const RID = '0192f0c4-1d2e-5a3b-8c4d-5e6f7a8b9c0d';
const OTHER = '0192f0c4-1d2e-5a3b-8c4d-000000000000';

function intent(overrides: Partial<IntentState> = {}): IntentState {
  return { sent: 1, uncertain: false, ...overrides };
}

const created: ReserveAnswer = {
  status: 201,
  order: { id: RID, status: 'RESERVED', qty: 1 },
  replayed: false,
};
const replay: ReserveAnswer = { status: 200, order: { id: RID, status: 'RESERVED', qty: 1 }, replayed: true };
const soldOut: ReserveAnswer = { status: 409, replayed: false, code: 'SOLD_OUT' };

/** Judges the answers of one intent in the order the burst does, and returns the verdict kinds. */
function judgeAll(state: IntentState, answers: readonly ReserveAnswer[]): string[] {
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
    const other: ReserveAnswer = { ...replay, order: { id: OTHER, status: 'RESERVED', qty: 1 } };
    expect(judgeAll(intent({ sent: 2 }), [created, other])).toEqual(['created', 'mismatch']);
  });

  it('flags a refusal of an order that exists', () => {
    expect(judgeAll(intent({ sent: 2 }), [created, soldOut])).toEqual(['created', 'mismatch']);
  });

  it('judges concurrent copies creation first, so the 201 names the order its twin replays', () => {
    const state = intent({ sent: 2 });
    expect(judgeAll(state, [replay, created].sort(byJudgingOrder))).toEqual(['created', 'replayed']);
    // A same-key pair answered with a creation and a refusal means the second request did not wait for
    // the first one's commit (§4.5).
    expect(judgeAll(intent({ sent: 2 }), [soldOut, created].sort(byJudgingOrder))).toEqual([
      'created',
      'mismatch',
    ]);
    expect(judgeAll(intent({ sent: 2 }), [soldOut, soldOut])).toEqual(['sold-out', 'sold-out']);
  });

  it('classifies refusals, expiry and rate limiting', () => {
    const limit: ReserveAnswer = { status: 409, replayed: false, code: 'LIMIT_REACHED' };
    const notLive: ReserveAnswer = { status: 409, replayed: false, code: 'DROP_NOT_LIVE' };
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
  const expected = { rid: RID, qty: 1 };

  it('accepts the creation and header-marked replays of the one order', () => {
    expect(judgeStormAnswer(expected, created)).toBe('created');
    expect(judgeStormAnswer(expected, replay)).toBe('replayed');
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
