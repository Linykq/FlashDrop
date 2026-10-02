import { cx } from '../../lib/cx';
import { describeStock, type StockState } from '../../lib/stock';
import { Countdown } from './countdown';
import { StockMeter } from './stock-meter';

type StockTextProps = {
  stock: StockState;
  /** For the countdown of a drop that hasn't opened yet. */
  startsAt: string;
  serverNow: number;
  /** sm in drop cards, md in the purchase panel and the hero; `none` drops the meter and its reserved space. */
  meter?: 'sm' | 'md' | 'none';
  /** Primary and secondary on one centred line, as in the home hero (§10.1). */
  layout?: 'stacked' | 'compact';
  /**
   * On a material (sticky buy bar, docked drop card) the primary line stays `label`, urgent or not, because
   * `danger` loses its contrast there; the word "Only" carries the urgency (§2.5, §9.9).
   */
  onMaterial?: boolean;
  className?: string;
};

/**
 * The stock block of LiveStock (§9.9): what is left, how much is claimed, and the meter. It renders one
 * snapshot, so SSR puts the number in the raw HTML (SD §8.1); the live island (M5) re-renders it from the
 * realtime store. It is not a live region: stock announcements go through the Announcer, on thresholds only.
 * Every state takes the same height, so a state change never moves the layout.
 */
export function StockText({
  stock,
  startsAt,
  serverNow,
  meter = 'md',
  layout = 'stacked',
  onMaterial = false,
  className,
}: StockTextProps) {
  const view = describeStock(stock);
  const primary = view.primary ?? <Countdown target={startsAt} serverNow={serverNow} verb="Starts" />;
  const urgentText = view.urgent && !onMaterial;

  return (
    <div className={cx('flex flex-col', layout === 'compact' && 'items-center text-center', className)}>
      {layout === 'compact' ? (
        <p className="text-headline">
          <span className={cx(urgentText && 'text-danger')}>{primary}</span>
          <span className="font-normal text-label-secondary"> · {view.secondary}</span>
        </p>
      ) : (
        <>
          <p className={cx('text-headline tabular-nums', urgentText && 'text-danger')}>{primary}</p>
          <p className="mt-1 text-footnote text-label-secondary tabular-nums">{view.secondary}</p>
        </>
      )}
      {meter !== 'none' && (
        // Hidden rather than removed before the drop opens, so the block keeps its height (§9.9).
        <div
          className={cx('mt-2 w-full', layout === 'compact' && 'max-w-90', !view.showMeter && 'invisible')}
        >
          <StockMeter
            avail={stock.avail}
            held={stock.held}
            sold={stock.sold}
            size={meter}
            urgent={view.urgent}
          />
        </div>
      )}
    </div>
  );
}
