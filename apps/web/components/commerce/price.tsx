import { cx } from '../../lib/cx';
import { formatMoney } from '../../lib/format';

type PriceProps = {
  cents: number;
  currency: string;
  /**
   * `inherit` in tiles, cards and tables; `lg` in the purchase panel, in the regular-weight intro style, so it
   * reads well below the semibold title; `total` for checkout and order totals.
   */
  size?: 'inherit' | 'lg' | 'total';
};

/** A price is never coloured and never struck through (§9.8). Totals always show cents. */
export function Price({ cents, currency, size = 'inherit' }: PriceProps) {
  return (
    <span className={cx('tabular-nums', size === 'lg' && 'text-intro', size === 'total' && 'text-headline')}>
      {formatMoney(cents, currency, size === 'total' ? 'exact' : 'storefront')}
    </span>
  );
}
