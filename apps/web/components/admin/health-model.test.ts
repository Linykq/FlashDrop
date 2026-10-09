import type { ConsumerGroupLag } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import {
  countHealth,
  deadLetterLine,
  driftHealth,
  EMPTY_LAG,
  FEATURED_DROPS,
  featuredDrops,
  groupHealth,
  type LagTracker,
  outboxHealth,
  type PipelineCheck,
  rebuildHealth,
  splitSkippedNote,
  summarizeHealth,
  trackLag,
  worst,
} from './health-model';

function group(lag: number, committed = '10'): ConsumerGroupLag {
  return {
    name: 'dashboard',
    groupId: 'sales-dashboard',
    lag,
    partitions: [{ partition: 0, committed, lag }],
  };
}

function polls(lags: readonly (readonly [number, number, string?])[]): LagTracker {
  return lags.reduce(
    (tracker, [at, lag, committed]) => trackLag(tracker, [group(lag, committed)], at),
    EMPTY_LAG,
  );
}

describe('health thresholds', () => {
  it('grades outbox lag at 2 and 10 seconds', () => {
    expect(outboxHealth(null)).toBe('healthy');
    expect(outboxHealth(1.9)).toBe('healthy');
    expect(outboxHealth(2)).toBe('degraded');
    expect(outboxHealth(10)).toBe('degraded');
    expect(outboxHealth(10.1)).toBe('failing');
  });

  it('fails any dead letter not yet replayed, and knows nothing without Kafka', () => {
    expect(deadLetterLine(14)).toBe('Not replayed · 14 retained');
    expect(deadLetterLine(null)).toBe("Kafka didn't answer");
    expect(countHealth(0)).toBe('healthy');
    expect(countHealth(1)).toBe('failing');
    expect(countHealth(null)).toBe('unknown');
  });

  it('fails drift only on two stable non-zero samples in a row', () => {
    expect(driftHealth([])).toBe('unknown');
    expect(driftHealth([null])).toBe('unknown');
    expect(driftHealth([3, 0])).toBe('healthy');
    expect(driftHealth([0, -2])).toBe('degraded');
    expect(driftHealth([-2, null, -2])).toBe('failing');
  });

  it('grades rebuilds by their age', () => {
    const now = Date.parse('2026-10-06T19:00:40.000Z');
    expect(rebuildHealth([], now)).toBe('healthy');
    expect(rebuildHealth(['2026-10-06T19:00:20.000Z'], now)).toBe('degraded');
    expect(rebuildHealth(['2026-10-06T19:00:00.000Z'], now)).toBe('failing');
  });

  it('takes the worst level', () => {
    expect(worst(['healthy', 'degraded', 'unknown'])).toBe('degraded');
    expect(worst(['healthy', 'failing', 'degraded'])).toBe('failing');
    expect(worst([])).toBe('healthy');
  });
});

describe('consumer lag trend', () => {
  it('is healthy at 0 and while falling', () => {
    expect(groupHealth(polls([[0, 0]]), 'dashboard', 0)).toBe('healthy');
    const falling = polls([
      [0, 40, '1'],
      [20_000, 30, '2'],
      [40_000, 12, '3'],
    ]);
    expect(groupHealth(falling, 'dashboard', 40_000)).toBe('healthy');
  });

  it('degrades when lag kept rising for over 30 s', () => {
    const rising = polls([
      [0, 5, '1'],
      [15_000, 9, '2'],
      [35_000, 14, '3'],
    ]);
    expect(groupHealth(rising, 'dashboard', 35_000)).toBe('degraded');
    // Under 30 s of history it can't be called a trend yet.
    expect(
      groupHealth(
        polls([
          [0, 5, '1'],
          [20_000, 9, '2'],
        ]),
        'dashboard',
        20_000,
      ),
    ).toBe('healthy');
  });

  it('fails a lagging partition stuck on one offset for over 5 minutes', () => {
    const stuck = polls([
      [0, 3, '7'],
      [150_000, 3, '7'],
      [301_000, 3, '7'],
    ]);
    expect(groupHealth(stuck, 'dashboard', 301_000)).toBe('failing');
    const moving = polls([
      [0, 3, '7'],
      [150_000, 3, '8'],
      [301_000, 3, '9'],
    ]);
    expect(groupHealth(moving, 'dashboard', 301_000)).not.toBe('failing');
  });

  it('keeps the history through a poll without Kafka', () => {
    const tracker = polls([[0, 4, '1']]);
    expect(trackLag(tracker, null, 5_000)).toBe(tracker);
  });
});

describe('tracked drops', () => {
  const drop = (
    id: string,
    status: string,
    owed = false,
    drift: number | null = 0,
    rebuilding: string | null = null,
  ) => ({
    dropId: id,
    status,
    pending: owed ? ['settlement'] : [],
    redisDriftUnits: drift,
    rebuildingSince: rebuilding,
  });

  it('puts drops that need a look first, then open ones, and keeps idle ended drops back', () => {
    const { featured, rest } = featuredDrops([
      drop('a', 'ENDED'),
      drop('b', 'LIVE'),
      drop('c', 'ENDED', true),
      drop('d', 'ENDED', false, -2),
      drop('e', 'SCHEDULED', false, null, '2026-10-06T19:00:00.000Z'),
      drop('f', 'ENDED', false, null),
    ]);
    expect(featured.map((entry) => entry.dropId)).toEqual(['c', 'd', 'e', 'b']);
    expect(rest.map((entry) => entry.dropId)).toEqual(['a', 'f']);
  });

  it('features at most a dozen, however many owe work', () => {
    const many = Array.from({ length: 30 }, (_, index) => drop(String(index), 'ENDED', true));
    const { featured, rest } = featuredDrops(many);
    expect(featured).toHaveLength(FEATURED_DROPS);
    expect(rest).toHaveLength(30 - FEATURED_DROPS);
  });
});

describe('health summary', () => {
  const holds = Array.from({ length: 9 }, (_, index) => ({
    id: `INV-${index + 1}`,
    title: `Invariant ${index + 1}`,
    status: 'holds' as const,
  }));
  const pipeline = (levels: Partial<Record<string, PipelineCheck['level']>> = {}): PipelineCheck[] =>
    [
      ['outbox', 'Outbox lag'],
      ['dead-letters', 'Dead letters'],
    ].map(([id = '', label = '']) => ({ id, label, level: levels[id] ?? 'healthy' }));

  it('says everything is healthy only when every invariant and every pipeline check is', () => {
    expect(summarizeHealth(holds, [], pipeline())).toEqual({
      tone: 'success',
      title: null,
      lines: [{ text: 'Everything is healthy. All 9 invariants hold.', targets: [] }],
    });
  });

  it('fails on a failing pipeline check even while every invariant holds, headed by the failure', () => {
    expect(summarizeHealth(holds, [], pipeline({ 'dead-letters': 'failing' }))).toEqual({
      tone: 'danger',
      title: {
        text: '1 pipeline check is failing:',
        targets: [{ kind: 'pipeline', id: 'dead-letters', label: 'Dead letters' }],
      },
      lines: [{ text: 'All 9 invariants hold.', targets: [] }],
    });
  });

  it('warns on degraded and unreadable checks, and on invariants that could not be checked', () => {
    const unchecked = holds.map((check) =>
      check.id === 'INV-5' ? { ...check, status: 'unchecked' as const } : check,
    );
    const summary = summarizeHealth(
      unchecked,
      ['Kafka'],
      pipeline({ outbox: 'degraded', 'dead-letters': 'unknown' }),
    );
    expect(summary.tone).toBe('warning');
    expect(summary.title?.text).toBe('8 of 9 invariants hold. 1 couldn’t be checked: Kafka didn’t answer.');
    expect(summary.lines.map((line) => line.text)).toEqual([
      '1 pipeline check is degraded:',
      '1 pipeline check couldn’t be read:',
    ]);
  });

  it('puts breached invariants first, linked to their rows', () => {
    const breached = holds.map((check) =>
      check.id === 'INV-1' || check.id === 'INV-3' ? { ...check, status: 'breached' as const } : check,
    );
    const summary = summarizeHealth(breached, [], pipeline({ outbox: 'degraded' }));
    expect(summary.tone).toBe('danger');
    expect(summary.title).toEqual({
      text: '2 invariants are failing:',
      targets: [
        { kind: 'invariant', id: 'INV-1', label: 'INV-1 Invariant 1' },
        { kind: 'invariant', id: 'INV-3', label: 'INV-3 Invariant 3' },
      ],
    });
    // No "invariants hold" line beside breached ones.
    expect(summary.lines.map((line) => line.text)).toEqual(['1 pipeline check is degraded:']);
  });
});

describe('invariant details', () => {
  it('takes the repeated sampling note off every detail and keeps its count once', () => {
    const { checks, skipped } = splitSkippedNote([
      { id: 'INV-1', detail: 'reserved + sold <= total on 12 drops; 723 ended test drops not sampled' },
      {
        id: 'INV-5',
        detail: '0 outbox rows unpublished, consumer lag 0; 12 drops compared with the dashboard',
      },
      { id: 'INV-9', detail: 'Redis conservation on 1 drop; 1 ended test drop not sampled' },
    ]);
    expect(checks.map((check) => check.detail)).toEqual([
      'reserved + sold <= total on 12 drops',
      '0 outbox rows unpublished, consumer lag 0; 12 drops compared with the dashboard',
      'Redis conservation on 1 drop',
    ]);
    expect(skipped).toBe(723);
    expect(splitSkippedNote([{ detail: 'Kafka did not answer' }]).skipped).toBe(0);
  });
});
