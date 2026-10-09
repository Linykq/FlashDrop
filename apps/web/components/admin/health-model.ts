import type { ConsumerGroupLag } from '@flashdrop/contracts';
import { formatCount } from '../../lib/format';

/*
 * The health tiles' thresholds (design system §10.11, matching the alerts of SD §12), as pure functions over
 * what the admin pages poll every 5 s. Consumer lag is judged by its trend, which no single response holds,
 * so the pages keep a short history of their own polls (`trackLag`).
 */

export type HealthLevel = 'healthy' | 'degraded' | 'failing' | 'unknown';

const ORDER: readonly HealthLevel[] = ['healthy', 'unknown', 'degraded', 'failing'];

/** The worst of several levels: one failing check makes the tile failing. */
export function worst(levels: readonly HealthLevel[]): HealthLevel {
  return levels.reduce<HealthLevel>(
    (current, level) => (ORDER.indexOf(level) > ORDER.indexOf(current) ? level : current),
    'healthy',
  );
}

/** Outbox lag: under 2 s healthy, 2 to 10 s degraded, over 10 s failing. Nothing pending is healthy. */
export function outboxHealth(oldestSeconds: number | null): HealthLevel {
  if (oldestSeconds === null || oldestSeconds < 2) return 'healthy';
  return oldestSeconds <= 10 ? 'degraded' : 'failing';
}

/**
 * The dead-letter tile's sub-line: its value counts what `dlq:replay` has not handled, the only part to act
 * on; the topic keeps every record for 30 days, replayed or not, which is context.
 */
export function deadLetterLine(retained: number | null): string {
  return retained === null ? "Kafka didn't answer" : `Not replayed · ${formatCount(retained)} retained`;
}

/** What replays dead letters (SD §12 runbook): see what it would do first, then run it without the flag. */
export const DLQ_REPLAY_COMMAND = 'pnpm dlq:replay --dry-run';

/** Dead letters and quarantined orders: any is failing; `null` (Kafka didn't answer) is unknown. */
export function countHealth(count: number | null): HealthLevel {
  if (count === null) return 'unknown';
  return count === 0 ? 'healthy' : 'failing';
}

/**
 * Redis drift (§10.11): 0 is healthy; non-zero over two stable samples in a row is failing. One stable non-zero
 * sample is degraded: a single reading may still be the tail of in-flight work. `null` samples (not
 * comparable: no Redis state, a rebuild, an unstable sample) don't count either way.
 */
export function driftHealth(samples: readonly (number | null)[]): HealthLevel {
  const stable = samples.filter((sample): sample is number => sample !== null);
  const last = stable.at(-1);
  if (last === undefined) return 'unknown';
  if (last === 0) return 'healthy';
  const previous = stable.at(-2);
  return previous !== undefined && previous !== 0 ? 'failing' : 'degraded';
}

/** Drops rebuilding: none healthy, under 30 s degraded, longer failing. */
export function rebuildHealth(rebuildingSince: readonly string[], now: number): HealthLevel {
  if (rebuildingSince.length === 0) return 'healthy';
  const longest = Math.max(...rebuildingSince.map((since) => now - Date.parse(since)));
  return longest > 30_000 ? 'failing' : 'degraded';
}

/** How far back the lag history reaches: past the 5-minute stall threshold. */
const HISTORY_MS = 6 * 60_000;
const RISING_MS = 30_000;
const STUCK_MS = 5 * 60_000;

export type LagTracker = {
  /** Each group's total lag at each poll, oldest first. */
  readonly totals: ReadonlyMap<string, readonly { at: number; lag: number }[]>;
  /** Per lagging partition (`group:partition`): its committed offset and since when it hasn't moved. */
  readonly stalls: ReadonlyMap<string, { committed: string | null; since: number }>;
};

export const EMPTY_LAG: LagTracker = { totals: new Map(), stalls: new Map() };

/** Folds one poll's consumer lag into the history. A poll without Kafka (`null`) changes nothing. */
export function trackLag(
  tracker: LagTracker,
  groups: readonly ConsumerGroupLag[] | null,
  at: number,
): LagTracker {
  if (groups === null) return tracker;
  const totals = new Map<string, { at: number; lag: number }[]>();
  const stalls = new Map<string, { committed: string | null; since: number }>();
  for (const group of groups) {
    const past = (tracker.totals.get(group.name) ?? []).filter((sample) => at - sample.at <= HISTORY_MS);
    totals.set(group.name, [...past, { at, lag: group.lag }]);
    for (const partition of group.partitions) {
      if (partition.lag === 0) continue;
      const key = `${group.name}:${partition.partition}`;
      const previous = tracker.stalls.get(key);
      stalls.set(key, {
        committed: partition.committed,
        since: previous !== undefined && previous.committed === partition.committed ? previous.since : at,
      });
    }
  }
  return { totals, stalls };
}

/**
 * Records a group may owe before its projection counts as behind whatever its trend: a replay
 * (`pnpm dash:rebuild`) owes the whole topic and falls fast, but totals read off it are incomplete until it
 * is through, which "Healthy" beside six figures of lag would hide.
 */
export const BACKLOG = 1_000;

/**
 * A group's health (§10.11): lag 0, or falling, is healthy; lag that kept rising for over 30 s, or a backlog of
 * `BACKLOG` records or more, is degraded; a lagging partition whose committed offset hasn't moved for over 5
 * minutes is failing.
 */
export function groupHealth(tracker: LagTracker, group: string, now: number): HealthLevel {
  for (const [key, stall] of tracker.stalls) {
    if (key.startsWith(`${group}:`) && now - stall.since > STUCK_MS) return 'failing';
  }
  const samples = tracker.totals.get(group) ?? [];
  const latest = samples.at(-1);
  if (latest === undefined || latest.lag === 0) return 'healthy';
  if (latest.lag >= BACKLOG) return 'degraded';
  // Rising: every poll of the last 30 s (and the one just before them) saw at least the lag of the one before.
  const start = samples.findLastIndex((sample) => latest.at - sample.at >= RISING_MS);
  if (start === -1) return 'healthy';
  const window = samples.slice(start);
  const rising = window.every((sample, index) => index === 0 || sample.lag >= (window[index - 1]?.lag ?? 0));
  return rising && latest.lag > (window[0]?.lag ?? 0) ? 'degraded' : 'healthy';
}

/**
 * The events the sales projection still owes, when that many that its totals can't be read as current (a
 * replay after `pnpm dash:rebuild`, or a consumer far behind); `null` otherwise, or when Kafka didn't answer.
 * The dashboard then says totals are incomplete rather than showing zeros as if nothing had sold (§10.10).
 */
export function projectionBacklog(groups: readonly ConsumerGroupLag[] | null): number | null {
  const lag = groups?.find((group) => group.name === 'dashboard')?.lag ?? 0;
  return lag >= BACKLOG ? lag : null;
}

type TrackedDrop = {
  status: string;
  pending: readonly string[];
  redisDriftUnits: number | null;
  rebuildingSince: string | null;
};

/**
 * A tracked drop that needs a look: work a loop or consumer still owes it, a rebuild, or drift. Not merely
 * "not idle": api reports every drop not idle while the pipeline as a whole is busy (a load run elsewhere).
 */
export function needsAttention(drop: TrackedDrop): boolean {
  return drop.pending.length > 0 || drop.rebuildingSince !== null || (drop.redisDriftUnits ?? 0) !== 0;
}

/** At most this many tracked drops show before "Show all": a load run can leave hundreds owing work. */
export const FEATURED_DROPS = 12;

/**
 * The tracked drops worth showing first: those that need a look, then the ones still selling or about to, at
 * most `FEATURED_DROPS`; the rest (mostly idle drops that ended, often hundreds after load runs) wait behind
 * "Show all". Order is kept within each group.
 */
export function featuredDrops<T extends TrackedDrop>(drops: readonly T[]): { featured: T[]; rest: T[] } {
  const attention = drops.filter(needsAttention);
  const open = drops.filter((drop) => !needsAttention(drop) && drop.status !== 'ENDED');
  const ended = drops.filter((drop) => !needsAttention(drop) && drop.status === 'ENDED');
  const first = [...attention, ...open];
  return { featured: first.slice(0, FEATURED_DROPS), rest: [...first.slice(FEATURED_DROPS), ...ended] };
}

/** A pipeline tile's verdict (§10.11), named as on its tile. */
export type PipelineCheck = { id: string; label: string; level: HealthLevel };

type InvariantVerdict = { id: string; title: string; status: 'holds' | 'breached' | 'unchecked' };

/** The note api appends to every sampled invariant's detail: "; 723 ended test drops not sampled". */
const SKIPPED_NOTE = /; (\d+) ended test drops? not sampled$/;

/**
 * The invariants' details without the sampling note api repeats on each of them, and its count once, for a
 * footnote under the table: nine copies of it buried the part of each line that differs, and on a phone cut
 * it off. A detail without the note is left as it is.
 */
export function splitSkippedNote<T extends { detail: string }>(
  checks: readonly T[],
): { checks: T[]; skipped: number } {
  let skipped = 0;
  const stripped = checks.map((check) => {
    const match = SKIPPED_NOTE.exec(check.detail);
    if (match === null) return check;
    skipped = Math.max(skipped, Number(match[1]));
    return { ...check, detail: check.detail.slice(0, match.index) };
  });
  return { checks: stripped, skipped };
}

/** A check a summary line names: an invariant's row or a pipeline tile, which the banner links to. */
export type SummaryTarget = { kind: 'invariant' | 'pipeline'; id: string; label: string };

/** A sentence of the summary; one with targets ends with them ("…failing: Dead letters."). */
export type SummaryLine = { text: string; targets: readonly SummaryTarget[] };

export type HealthSummary = {
  tone: 'success' | 'warning' | 'danger';
  /** The most severe problem, as the banner's headline; `null` when everything is healthy. */
  title: SummaryLine | null;
  /** The other problems, most severe first, then what is fine ("All 9 invariants hold."). */
  lines: readonly SummaryLine[];
};

const are = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The health page's summary banner (§10.11): every check on the page, invariants and pipeline tiles alike,
 * so the banner at the top never says "healthy" while a tile below it fails. Its tone is the worst of them,
 * and its headline the most severe problem: a danger banner that opened with "All 9 invariants hold." read
 * as good news first. Severity: breached invariants, failing tiles, invariants that couldn't be checked,
 * degraded tiles, tiles that couldn't be read.
 */
export function summarizeHealth(
  invariants: readonly InvariantVerdict[],
  unavailable: readonly string[],
  pipeline: readonly PipelineCheck[],
): HealthSummary {
  const breached = invariants.filter((check) => check.status === 'breached');
  const unchecked = invariants.filter((check) => check.status === 'unchecked');
  const total = invariants.length;
  const tiles = (level: HealthLevel): SummaryTarget[] =>
    pipeline
      .filter((check) => check.level === level)
      .map((check) => ({ kind: 'pipeline', id: check.id, label: check.label }));
  const failing = tiles('failing');
  const degraded = tiles('degraded');
  const unknown = tiles('unknown');

  const problems: SummaryLine[] = [];
  if (breached.length > 0) {
    problems.push({
      text: `${are(breached.length, 'invariant is', 'invariants are')} failing:`,
      targets: breached.map((check) => ({
        kind: 'invariant',
        id: check.id,
        label: `${check.id} ${check.title}`,
      })),
    });
  }
  if (failing.length > 0) {
    problems.push({
      text: `${are(failing.length, 'pipeline check is', 'pipeline checks are')} failing:`,
      targets: failing,
    });
  }
  if (breached.length === 0 && unchecked.length > 0) {
    const why = unavailable.length > 0 ? `: ${unavailable.join(', ')} didn’t answer.` : '.';
    problems.push({
      text: `${total - unchecked.length} of ${total} invariants hold. ${unchecked.length} couldn’t be checked${why}`,
      targets: [],
    });
  }
  if (degraded.length > 0) {
    problems.push({
      text: `${are(degraded.length, 'pipeline check is', 'pipeline checks are')} degraded:`,
      targets: degraded,
    });
  }
  if (unknown.length > 0) {
    problems.push({
      text: `${are(unknown.length, 'pipeline check', 'pipeline checks')} couldn’t be read:`,
      targets: unknown,
    });
  }

  const [title, ...rest] = problems;
  if (title === undefined) {
    return {
      tone: 'success',
      title: null,
      lines: [{ text: `Everything is healthy. All ${total} invariants hold.`, targets: [] }],
    };
  }
  const invariantsHold = breached.length === 0 && unchecked.length === 0;
  return {
    tone: breached.length > 0 || failing.length > 0 ? 'danger' : 'warning',
    title,
    lines: invariantsHold ? [...rest, { text: `All ${total} invariants hold.`, targets: [] }] : rest,
  };
}
