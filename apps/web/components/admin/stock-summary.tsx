import { cx } from '../../lib/cx';
import { formatCount } from '../../lib/format';
import { StockMeter } from '../commerce/stock-meter';

const LEGEND = [
  { key: 'avail', label: 'Available', swatch: 'bg-fill-secondary' },
  { key: 'held', label: 'In carts', swatch: 'bg-chart-2' },
  { key: 'sold', label: 'Sold', swatch: 'bg-chart-1' },
] as const;

/**
 * A drop's stock in admin (design system §9.9, §10.8, §10.10): the lg meter in the admin colours (sold
 * `chart-1`, held `chart-2`, the rest the track) and a legend with every number, so the meter itself stays
 * decorative. `columns` is 4 in a wide card, 2 in a narrow one.
 */
export function StockSummary({
  avail,
  held,
  sold,
  total,
  columns = 4,
}: {
  avail: number;
  held: number;
  sold: number;
  total: number;
  columns?: 2 | 4;
}) {
  const values = { avail, held, sold };
  return (
    <>
      <StockMeter avail={avail} held={held} sold={sold} size="lg" palette="admin" className="mt-4" />
      <dl className={cx('mt-5 grid grid-cols-2 gap-x-6 gap-y-4', columns === 4 && 'sm:grid-cols-4')}>
        {LEGEND.map(({ key, label, swatch }) => (
          <div key={key}>
            <dt className="flex items-center gap-1.5 text-footnote text-label-secondary">
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${swatch}`} />
              {label}
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
