import type { OrderDetail } from '@flashdrop/contracts';
import { paymentMethodLabel } from '../../lib/checkout-form';
import { shortId } from '../../lib/format';
import { formatShipping } from '../../lib/order-status';
import { LocalTime } from '../commerce/local-time';
import { CopyId } from '../ui/copy-id';
import { KeyValueList } from '../ui/key-value-list';

/**
 * The order's facts (design-system §10.5) as a key-value list in a card: the short id with a copy button, and
 * once submitted where it ships and how it was paid. What was bought, how many and the total are the summary
 * card's above it. Rows without a value, such as Ship to on an order that expired before checkout, are left out.
 */
export function OrderDetails({ order }: { order: OrderDetail }) {
  return (
    <section aria-labelledby="order-details" className="rounded-lg bg-surface px-5 py-1 elevation-1 sm:px-6">
      <h2 id="order-details" className="sr-only">
        Order details
      </h2>
      <KeyValueList
        rows={[
          {
            key: 'Order',
            value: (
              <span className="inline-flex items-center gap-2 tabular-nums">
                {shortId(order.id)}
                <CopyId id={order.id} noun="order" />
              </span>
            ),
          },
          { key: 'Ship to', value: order.shipping ? formatShipping(order.shipping) : null },
          { key: 'Payment', value: order.paymentMethod ? paymentMethodLabel(order.paymentMethod) : null },
          // When the units were reserved: every order has that moment, including one that was never placed.
          { key: 'Reserved', value: <LocalTime iso={order.createdAt} /> },
        ]}
      />
    </section>
  );
}
