import type { DashboardTotals, DropStatus, SalesMinute } from '@flashdrop/contracts';
import { formatCount } from '../../lib/format';
import type { FunnelSpec, UnitsSpec } from './chart-spec';
import { formatShortDuration } from './format';

/*
 * The live dashboard's numbers (SD §9, design system §10.10) from the projection's totals and its per-minute
 * series, as pure functions: the page re-derives them on every frame, and tests pin them down.
 */

const MINUTE_MS = 60_000;
/** The units chart shows at most the last three hours, one point per minute. */
export const MAX_POINTS = 180;

/** How much of the running minute a pace needs before it stands on that minute alone (`minutePace`). */
const PACE_WINDOW_S = 15;

/**
 * The running minute's pace: how many units it will have sold by its end at the rate it is selling now, so a
 * minute 10 s old doesn't plot as a collapse in sales. The rate is the units over the last 15 s at least: in
 * its first 15 s the minute borrows the rest of that window from the minute before, at that minute's average,
 * so the pace starts where the last closed minute ended rather than at the noise of a few seconds' arrivals.
 * Never below what the minute has already sold.
 */
export function minutePace(count: number, previous: number, elapsedMs: number): number {
  const elapsed = Math.min(Math.max(elapsedMs / 1000, 0), 60);
  const rate =
    elapsed >= PACE_WINDOW_S
      ? count / elapsed
      : (count + (previous * (PACE_WINDOW_S - elapsed)) / 60) / PACE_WINDOW_S;
  return Math.max(count, Math.round(rate * 60));
}

/**
 * Units sold per minute, with the minutes that sold nothing filled in as 0, from the first minute with an event
 * to `until` (now, while the drop runs; the last event otherwise). The series only holds minutes with events.
 * While the drop runs, the minute `until` falls in is still counting: it is marked `partial` and carries its
 * `pace` (`minutePace`), which the chart plots in its place.
 */
export function unitsPerMinute(
  series: readonly SalesMinute[],
  until: number | null,
  label: (minute: string) => string,
): UnitsSpec {
  const first = series[0];
  const last = series.at(-1);
  if (first === undefined || last === undefined) {
    return { kind: 'units', unit: 'units', points: [], ticks: niceTicks(0) };
  }
  const sold = new Map(series.map((minute) => [Date.parse(minute.minute), minute.unitsSold]));
  const current = until === null ? null : Math.floor(until / MINUTE_MS) * MINUTE_MS;
  const end = Math.max(Date.parse(last.minute), current ?? 0);
  const start = Math.max(Date.parse(first.minute), end - (MAX_POINTS - 1) * MINUTE_MS);
  const points: UnitsSpec['points'][number][] = [];
  for (let at = start; at <= end; at += MINUTE_MS) {
    const minute = new Date(at).toISOString();
    const value = sold.get(at) ?? 0;
    const pace =
      until !== null && at === current ? minutePace(value, sold.get(at - MINUTE_MS) ?? 0, until - at) : null;
    points.push({ minute, label: label(minute), value, partial: pace !== null, pace });
  }
  return {
    kind: 'units',
    unit: 'units',
    points,
    ticks: niceTicks(Math.max(...points.map((point) => Math.max(point.value, point.pace ?? 0)))),
  };
}

/**
 * About `target` round steps (1, 2 or 5 × 10ⁿ, never under 1: units are whole) from 0 to the first step at or
 * above `max`, for a value axis that reads 0, 50, 100, 150 rather than 0, 35, 70, 105, 140 (§9.23).
 */
export function niceTicks(max: number, target = 4): number[] {
  const top = Math.max(max, 1);
  const rough = top / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, ([1, 2, 5, 10].find((factor) => factor * magnitude >= rough) ?? 10) * magnitude);
  const ticks: number[] = [];
  for (let tick = 0; tick < top + step; tick += step) ticks.push(tick);
  return ticks;
}

/** The busiest minute of the chart, for its summary; `null` when nothing sold. */
export function peakMinute(spec: UnitsSpec): { label: string; value: number } | null {
  return spec.points.reduce<{ label: string; value: number } | null>(
    (peak, point) => (point.value > 0 && (peak === null || point.value > peak.value) ? point : peak),
    null,
  );
}

/** Reserved → placed → paid, then how the rest ended (§9): expired, cancelled, failed, rejected. */
export function funnel(totals: DashboardTotals): FunnelSpec {
  return {
    kind: 'funnel',
    bars: [
      { label: 'Reserved', value: totals.reserved, kind: 'flow' },
      { label: 'Placed', value: totals.placed, kind: 'flow' },
      { label: 'Paid', value: totals.paid, kind: 'flow' },
      { label: 'Expired', value: totals.expired, kind: 'outcome' },
      { label: 'Cancelled', value: totals.cancelled, kind: 'outcome' },
      { label: 'Failed', value: totals.failed, kind: 'outcome' },
      { label: 'Rejected', value: totals.rejected, kind: 'outcome' },
    ],
  };
}

/**
 * The sell-out tile's sub-line while units remain (§10.10): what is left, or, when every unit is either sold
 * or in a cart, the storefront's own wording, since "0 left" beside "Not sold out" reads as a contradiction.
 */
export function stockLeftLine(avail: number, held: number): string {
  return avail === 0 && held > 0
    ? `All reserved · ${formatCount(held)} in carts`
    : `${formatCount(avail)} left`;
}

/**
 * The sell-out tile before a sell-out (§10.10). Its label changes with the state rather than putting a
 * duration under "Time to sell-out", where any number reads as a sell-out time achieved or predicted: "Not
 * open" before the drop opens; "Selling for 13m", to the minute, while it sells ("Not sold out · 8 left");
 * "Ran for 30m" once it ended unsold. Values stay short enough for a fifth of the row, where "Not sold out"
 * would wrap, and are never a dash, which reads as still loading.
 */
export function unsoldTile(
  drop: { status: DropStatus; startsAt: string; endsAt: string },
  at: number,
  stock: { avail: number; held: number },
): { label: string; value: string; sub: string } {
  const left = stockLeftLine(stock.avail, stock.held);
  const start = Date.parse(drop.startsAt);
  const minutes = (ms: number) =>
    formatShortDuration(ms < MINUTE_MS ? ms / 1000 : Math.floor(ms / MINUTE_MS) * 60);
  if (drop.status === 'DRAFT' || drop.status === 'SCHEDULED' || at < start) {
    return { label: 'Time to sell-out', value: 'Not open', sub: left };
  }
  if (drop.status === 'ENDED') {
    return {
      label: 'Ran for',
      value: minutes(Date.parse(drop.endsAt) - start),
      sub: `Not sold out · ${left}`,
    };
  }
  // "All reserved · 4 in carts" says it isn't sold out already.
  const allReserved = stock.avail === 0 && stock.held > 0;
  return {
    label: 'Selling for',
    value: minutes(at - start),
    sub: allReserved ? left : `Not sold out · ${left}`,
  };
}

/**
 * Time to sell-out (§10.10): from the drop's start to the minute its units sold reached the total, to the
 * minute; `null` while it hasn't sold out.
 */
export function sellOutSeconds(startsAt: string, soldOutMinute: string | null): number | null {
  if (soldOutMinute === null) return null;
  // The sold-out minute is a bucket start: the last unit sold within it, so count the minute itself.
  return Math.max(0, (Date.parse(soldOutMinute) + MINUTE_MS - Date.parse(startsAt)) / 1000);
}
