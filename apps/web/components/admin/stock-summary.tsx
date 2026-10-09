import { cx } from '../../lib/cx';
import { formatCount } from '../../lib/format';
import { StockMeter } from '../commerce/stock-meter';

const LEGEND = [
  { key: 'avail', swatch: 'bg-fill-secondary' },
  { key: 'held', swatch: 'bg-chart-2' },
  { key: 'sold', swatch: 'bg-chart-1' },
] as const;

/**
 * A drop's stock in admin (design system §9.9, §10.8, §10.10): the lg meter in the admin colours (sold
 * `chart-1`, held `chart-2`, the rest the track) and a legend with every number, so the meter itself stays
 * decorative. `columns` is 4 in a wide card, 2 in a narrow one. Once the drop ended, what is left was never
 * sold, and the legend says "Unsold" rather than "Available", which would read as still on sale.
 */
export function StockSummary({
  avail,
  held,
  sold,
  total,
  columns = 4,
  ended = false,
}: {
  avail: number;
  held: number;
  sold: number;
  total: number;
  columns?: 2 | 4;
  ended?: boolean;
}) {
  const values = { avail, held, sold };
  const labels = { avail: ended ? 'Unsold' : 'Available', held: 'In carts', sold: 'Sold' };
  return (
    <>
      <StockMeter avail={avail} held={held} sold={sold} size="lg" palette="admin" className="mt-4" />
      <dl className={cx('mt-5 grid grid-cols-2 gap-x-6 gap-y-4', columns === 4 && 'sm:grid-cols-4')}>
        {LEGEND.map(({ key, swatch }) => (
          <div key={key}>
            <dt className="flex items-center gap-1.5 text-footnote text-label-secondary">
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${swatch}`} />
              {labels[key]}
            </dt>
            <dd className="mt-1 text-title-2 tabular-nums">{formatCount(values[key])}</dd>
          </div>
        ))}
        <div>
          <dt className="text-footnote text-label-secondary">Total</dt>
          <dd className="mt-1 text-title-2 tabular-nums">{formatCount(total)}</dd>
        </div>
      </dl>
    </>
  );
}
