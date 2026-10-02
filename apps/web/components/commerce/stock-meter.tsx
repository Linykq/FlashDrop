import { cx } from '../../lib/cx';

const heightClass = { sm: 'h-1', md: 'h-1.5', lg: 'h-3' } as const;

type StockMeterProps = {
  avail: number;
  held: number;
  sold: number;
  /** sm (4 px) in drop cards and table rows, md (6 px) in the purchase panel and hero, lg (12 px) in admin. */
  size?: keyof typeof heightClass;
  /** Sold and held in `danger`, the same red as the urgent stock text above the meter. */
  urgent?: boolean;
  /** Admin colours: sold `chart-1`, held `chart-2`, for a chart legend beside it. */
  palette?: 'store' | 'admin';
  className?: string;
};

const segmentClass = {
  store: { sold: 'bg-label', held: 'bg-label/35' },
  urgent: { sold: 'bg-danger', held: 'bg-danger/35' },
  admin: { sold: 'bg-chart-1', held: 'bg-chart-2' },
} as const;

/**
 * Sold, then held, then what is left (the track), with 2 px gaps that let the background through (§9.9).
 * Decorative: the stock text carries the meaning. Widths are the one layout property that animates (§6.1):
 * the bar is a few pixels tall and isolated.
 */
export function StockMeter({
  avail,
  held,
  sold,
  size = 'md',
  urgent = false,
  palette = 'store',
  className,
}: StockMeterProps) {
  const total = avail + held + sold;
  const colors = segmentClass[palette === 'admin' ? 'admin' : urgent ? 'urgent' : 'store'];
  const segments = [
    { key: 'sold', units: sold, className: colors.sold },
    { key: 'held', units: held, className: colors.held },
    { key: 'avail', units: avail, className: 'bg-fill-secondary' },
  ].filter((segment) => segment.units > 0);

  return (
    <div
      aria-hidden="true"
      className={cx('flex w-full gap-0.5 overflow-clip rounded-full', heightClass[size], className)}
    >
      {total === 0 ? (
        <div className="flex-1 bg-fill-secondary" />
      ) : (
        segments.map((segment) => (
          <div
            key={segment.key}
            className={cx(
              'min-w-0.5 motion-safe:transition-[flex-grow] motion-safe:duration-300 motion-safe:ease-out',
              segment.className,
            )}
            // flex-grow in units splits the width after the gaps, so a 1-unit segment still shows.
            style={{ flexGrow: segment.units, flexBasis: 0 }}
          />
        ))
      )}
    </div>
  );
}
