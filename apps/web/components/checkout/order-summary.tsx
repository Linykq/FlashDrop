import { type OrderView, uploadPath } from '@flashdrop/contracts';
import Image from 'next/image';
import { formatCount, formatMoney } from '../../lib/format';
import { Price } from '../commerce/price';
import { TitleText } from '../ui/title-text';

/**
 * What is held (design-system §10.4): the product with its unit price, the quantity and the line amount, then
 * the total. Checkout always shows cents (§3.3) and never truncates what is being bought: the title wraps.
 * An order is one line, so its amount is the total just below; on phones that column goes and the quantity
 * joins the unit price's line, so the title has the card's width. The thumbnail's alt text is empty: the title
 * beside it names the product.
 */
export function OrderSummary({ order }: { order: OrderView }) {
  const { product, qty, unitPriceCents, totalCents, currency } = order;
  const photo = product.imageKeys[0];
  return (
    <section aria-labelledby="order-summary" className="rounded-lg bg-surface p-5 elevation-1 sm:p-6">
      <h2 id="order-summary" className="sr-only">
        Order summary
      </h2>
      <div className="flex items-start gap-4">
        <div className="relative size-16 shrink-0 overflow-clip rounded-sm bg-bg-secondary">
          {photo && <Image src={uploadPath(photo)} alt="" fill sizes="64px" className="object-cover" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="wrap-break-word text-headline">
            <TitleText text={product.title} />
          </p>
          <p className="mt-0.5 text-footnote text-label-secondary tabular-nums">
            {formatMoney(unitPriceCents, currency, 'exact')} each
            <span className="sm:hidden"> · Qty {formatCount(qty)}</span>
          </p>
        </div>
        <div className="shrink-0 text-end max-sm:hidden">
          <p className="text-body tabular-nums">{formatMoney(unitPriceCents * qty, currency, 'exact')}</p>
          <p className="mt-0.5 text-footnote text-label-secondary tabular-nums">Qty {formatCount(qty)}</p>
        </div>
      </div>
      <div aria-hidden="true" className="my-4 h-px bg-separator sm:my-5" />
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-headline">Total</p>
        <Price cents={totalCents} currency={currency} size="total" />
      </div>
    </section>
  );
}
