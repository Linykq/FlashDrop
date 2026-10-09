'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  type BarShapeProps,
  CartesianGrid,
  Cell,
  LabelList,
  type LabelProps,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type YAxisTickContentProps,
} from 'recharts';
import { formatCount } from '../../lib/format';
import type { ChartSpec, FunnelSpec, UnitsSpec } from './chart-spec';

/*
 * The Recharts side of the admin charts (design system §9.23), loaded only in the browser through
 * `chart-frame.tsx`, so no storefront bundle carries it. Restrained on purpose: a hairline grid without
 * verticals, no axis lines or tick marks, caption-size ticks in `label-secondary`, a 2 px line over a 10%
 * fill, a custom tooltip on `material-thick`, and no animation, since live charts redraw up to 10 times a
 * second. Colours come from the chart tokens as CSS variables, so dark mode needs nothing here.
 */

const TICK = { fill: 'var(--color-label-secondary)', fontSize: 12 } as const;
/** Dots mark the minutes while there are few of them; a long series is read as a line. */
const DOTS_BELOW = 12;

export default function ChartView({ spec }: { spec: ChartSpec }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      {spec.kind === 'units' ? <UnitsChart spec={spec} /> : <FunnelChart spec={spec} />}
    </ResponsiveContainer>
  );
}

type UnitsDatum = UnitsSpec['points'][number] & {
  /** The closed minutes: the solid series. */
  closed: number | null;
  /**
   * The closed minute before the running one, at its count, then the running minute at its pace: the dashed
   * series that runs on from the line.
   */
  open: number | null;
};

function UnitsChart({ spec }: { spec: UnitsSpec }) {
  const data: UnitsDatum[] = spec.points.map((point, index) => ({
    ...point,
    closed: point.partial ? null : point.value,
    open: point.pace ?? (spec.points[index + 1]?.partial ? point.value : null),
  }));
  // Straight segments between minutes (not `monotone`): a smoothed curve would put its peaks between
  // minutes, where nothing was measured.
  const dot =
    spec.points.length < DOTS_BELOW ? { r: 3, strokeWidth: 0, fill: 'var(--color-chart-1)' } : false;
  const activeDot = { r: 4, stroke: 'var(--color-surface)', strokeWidth: 2, fill: 'var(--color-chart-1)' };
  return (
    // 24 px on the right: the last minute's tick label is centred on the plot's edge and would be clipped.
    <AreaChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }} accessibilityLayer={false}>
      <CartesianGrid vertical={false} stroke="var(--color-chart-grid)" />
      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={TICK} minTickGap={24} tickMargin={8} />
      <YAxis
        allowDecimals={false}
        axisLine={false}
        tickLine={false}
        tick={TICK}
        width={40}
        ticks={[...spec.ticks]}
        domain={[0, spec.ticks.at(-1) ?? 'auto']}
        interval={0}
        tickFormatter={(value: number) => formatCount(value)}
      />
      <Tooltip
        cursor={{ stroke: 'var(--color-separator)', strokeWidth: 1 }}
        isAnimationActive={false}
        content={({ active, payload, label }) => (
          <ChartTooltip active={active} datum={payload?.[0]?.payload} label={label} unit={spec.unit} />
        )}
      />
      <Area
        type="linear"
        dataKey="closed"
        name={spec.unit}
        stroke="var(--color-chart-1)"
        strokeWidth={2}
        fill="var(--color-chart-1)"
        fillOpacity={0.1}
        dot={dot}
        activeDot={activeDot}
        isAnimationActive={false}
      />
      <Area
        type="linear"
        dataKey="open"
        name={`${spec.unit} so far`}
        stroke="var(--color-chart-1)"
        strokeWidth={2}
        strokeDasharray="4 4"
        // Half the closed minutes' fill, so the area runs on to the running minute instead of ending in a wall.
        fill="var(--color-chart-1)"
        fillOpacity={0.05}
        dot={dot}
        activeDot={activeDot}
        isAnimationActive={false}
      />
    </AreaChart>
  );
}

/** The heading of the outcome bars, in a row of its own between the two groups (§10.10). */
const OUTCOME_GROUP = 'Ended without paying';

type FunnelDatum = { label: string; value: number; kind: FunnelSpec['bars'][number]['kind'] | 'group' };

function FunnelChart({ spec }: { spec: FunnelSpec }) {
  const firstOutcome = spec.bars.findIndex((bar) => bar.kind === 'outcome');
  const data: FunnelDatum[] =
    firstOutcome <= 0
      ? [...spec.bars]
      : [
          ...spec.bars.slice(0, firstOutcome),
          { label: OUTCOME_GROUP, value: 0, kind: 'group' },
          ...spec.bars.slice(firstOutcome),
        ];
  return (
    <BarChart
      data={data}
      layout="vertical"
      margin={{ top: 0, right: 48, bottom: 0, left: 0 }}
      barCategoryGap={6}
      accessibilityLayer={false}
    >
      <CartesianGrid horizontal={false} vertical={false} />
      <XAxis type="number" hide domain={[0, 'dataMax']} />
      <YAxis
        type="category"
        dataKey="label"
        axisLine={false}
        tickLine={false}
        tick={FunnelTick}
        interval={0}
        width={84}
      />
      <Bar
        dataKey="value"
        maxBarSize={24}
        radius={[0, 4, 4, 0]}
        isAnimationActive={false}
        // A shape of its own keeps the zero bars: Recharts drops zero-width bars, and their labels with them,
        // which left "Rejected" with nothing beside it rather than a 0.
        shape={(props: BarShapeProps) => <Rectangle {...props} />}
      >
        {data.map((bar) => (
          <Cell
            key={bar.label}
            fill={bar.kind === 'flow' ? 'var(--color-chart-1)' : 'var(--color-chart-muted)'}
          />
        ))}
        <LabelList dataKey="value" content={(props) => <BarValue {...props} data={data} />} />
      </Bar>
    </BarChart>
  );
}

/** A category name at the axis; the group heading starts at the left edge, in `label-secondary`. */
function FunnelTick({ x, y, payload }: YAxisTickContentProps) {
  const label = String(payload.value);
  const group = label === OUTCOME_GROUP;
  return (
    <text
      x={group ? 0 : Number(x)}
      y={Number(y)}
      dy="0.355em"
      textAnchor={group ? 'start' : 'end'}
      fill={group ? 'var(--color-label-secondary)' : 'var(--color-label)'}
      fontSize={group ? 13 : 12}
    >
      {label}
    </text>
  );
}

/** The value 8 px past a bar's end, a zero bar's included; none on the group heading's row. */
function BarValue({ viewBox, value, index, data }: LabelProps & { data: readonly FunnelDatum[] }) {
  if (index === undefined || data[index]?.kind === 'group') return null;
  if (!viewBox || !('width' in viewBox) || typeof value !== 'number') return null;
  const { x, y, width, height } = viewBox;
  return (
    <text
      x={x + Math.max(width, 0) + 8}
      y={y + height / 2}
      dy="0.355em"
      fill="var(--color-label)"
      fontSize={12}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {formatCount(value)}
    </text>
  );
}

const field = (datum: unknown, key: string): unknown =>
  typeof datum === 'object' && datum !== null ? Reflect.get(datum, key) : undefined;

/**
 * The tooltip on `material-thick`: everything on it is `label` (§2.5), values in tabular figures. The running
 * minute reads "42 units so far · on pace for 118".
 */
function ChartTooltip({
  active,
  datum,
  label,
  unit,
}: {
  active: boolean | undefined;
  datum: unknown;
  label: unknown;
  unit: string;
}) {
  const value = field(datum, 'value');
  const pace = field(datum, 'pace');
  if (!active || typeof value !== 'number') return null;
  return (
    <div className="material-thick rounded-md px-3 py-2 text-footnote text-label elevation-2">
      <p className="tabular-nums">{String(label)}</p>
      <p className="mt-0.5 flex items-center gap-1.5 tabular-nums">
        <span aria-hidden="true" className="size-2 rounded-full bg-chart-1" />
        {formatCount(value)} {unit}
        {typeof pace === 'number' && ` so far · on pace for ${formatCount(pace)}`}
      </p>
    </div>
  );
}
