/*
 * What an admin chart shows, independent of how it is drawn: `chart-view.tsx` draws it with Recharts and
 * `chart-frame.tsx` renders the same data as the chart's visually hidden table (SD §9).
 */

/** Units sold per minute: one point per minute, labelled in the viewer's zone ("7:02 PM"). */
export type UnitsSpec = {
  kind: 'units';
  /** How the value reads in the tooltip and the table: "units". */
  unit: string;
  /**
   * `value`: the units sold in the minute. `partial`: the minute still running, `value` so far; it is drawn
   * apart (dashed) at its `pace`, the units it is on course for, since a minute half over would otherwise read
   * as a fall in sales. `pace` is `null` on every closed minute.
   */
  points: readonly { minute: string; label: string; value: number; partial: boolean; pace: number | null }[];
  /** Round values for the value axis, from 0 up to the top of the axis (`niceTicks`). */
  ticks: readonly number[];
};

/** The order funnel: reserved, placed, paid in the accent series, then the ways orders ended unpaid. */
export type FunnelSpec = {
  kind: 'funnel';
  bars: readonly { label: string; value: number; kind: 'flow' | 'outcome' }[];
};

export type ChartSpec = UnitsSpec | FunnelSpec;
