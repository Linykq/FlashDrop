'use client';

import dynamic from 'next/dynamic';
import { useId } from 'react';
import { cx } from '../../lib/cx';
import { formatCount } from '../../lib/format';
import { Skeleton } from '../ui/skeleton';
import type { ChartSpec } from './chart-spec';

// Recharts loads only in the browser and only on the pages that chart (design system §8.7, §14). The
// skeleton has the plot's final size, so nothing moves when it arrives.
const ChartView = dynamic(() => import('./chart-view'), {
  ssr: false,
  loading: () => <Skeleton className="size-full rounded-md" />,
});

type ChartFrameProps = {
  title: string;
  description?: string;
  /** The chart's one-sentence summary for assistive technology (§9.23). */
  summary: string;
  spec: ChartSpec;
  className?: string;
};

/**
 * A chart in a card (design system §9.23): headline title, optional description, the plot (240 px tall on a
 * phone, 280 px from 735 px) as an image with a summary, followed by a visually hidden table of the same data
 * (SD §9), which is what a screen reader reads instead.
 */
export function ChartFrame({ title, description, summary, spec, className }: ChartFrameProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={cx('rounded-lg bg-surface p-5 elevation-1 sm:p-6', className)}
    >
      <h2 id={titleId} className="text-headline">
        {title}
      </h2>
      {description && <p className="mt-1 text-footnote text-label-secondary">{description}</p>}
      <div role="img" aria-label={summary} className="mt-4 h-60 tabular-nums sm:h-70">
        <ChartView spec={spec} />
      </div>
      <ChartTable title={title} spec={spec} />
    </section>
  );
}

function ChartTable({ title, spec }: { title: string; spec: ChartSpec }) {
  return (
    <table className="sr-only">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">{spec.kind === 'units' ? 'Minute' : 'Stage'}</th>
          <th scope="col">{spec.kind === 'units' ? `Units sold` : 'Orders'}</th>
        </tr>
      </thead>
      <tbody>
        {spec.kind === 'units'
          ? spec.points
              // Minutes without sales add nothing a listener needs; the chart shows them as gaps.
              .filter((point) => point.value > 0)
              .map((point) => (
                <tr key={point.minute}>
                  <th scope="row">
                    {point.pace === null
                      ? point.label
                      : `${point.label}, so far, on pace for ${formatCount(point.pace)}`}
                  </th>
                  <td>{formatCount(point.value)}</td>
                </tr>
              ))
          : spec.bars.map((bar) => (
              <tr key={bar.label}>
                <th scope="row">{bar.label}</th>
                <td>{formatCount(bar.value)}</td>
              </tr>
            ))}
      </tbody>
    </table>
  );
}
