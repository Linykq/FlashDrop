import { type OrderView, uploadPath } from '@flashdrop/contracts';
import { ChevronRight } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { cx } from '../../lib/cx';
import { formatMoney } from '../../lib/format';
import { liveHoldsFirst } from '../../lib/hold';
import { orderHref } from '../../lib/routes';
import { SkeletonText } from '../ui/skeleton';
import { TitleText } from '../ui/title-text';
import { OrderRowStatus } from './order-row-status';

/**
 * The buyer's orders as one grouped list (design-system §10.6): live holds first, then newest first. Each row
 * is one link, at least 64 px tall, with the thumbnail, the title over the meta line (when it was placed and
 * what it came to, or a hold's time left), the status pill and a chevron. On phones the pill moves onto the
 * meta line, so the title has the row's full width. Hairlines between rows start at the text, as in an iOS
 * grouped list. The thumbnail's alt text is empty: the title beside it names the product.
 */
export function OrderList({ orders }: { orders: readonly OrderView[] }) {
  return (
    <ul>
      {liveHoldsFirst(orders).map((order, index) => (
        <li key={order.id}>
          <Link
            href={orderHref(order)}
            className={cx(
              'flex items-center gap-3 pl-4 sm:pl-5',
              'transition-colors duration-100 ease-standard hover:bg-fill-quaternary hover:duration-200 active:bg-fill-tertiary active:duration-0',
              // The hover fill follows the card's corners on the first and last row.
              '[li:first-child>&]:rounded-t-lg [li:last-child>&]:rounded-b-lg',
            )}
          >
            <div className="relative size-10 shrink-0 overflow-clip rounded-sm bg-bg-secondary">
              {order.product.imageKeys[0] && (
                <Image
                  src={uploadPath(order.product.imageKeys[0])}
                  alt=""
                  fill
                  sizes="40px"
                  className="object-cover"
                />
              )}
            </div>
            {/* Title, pill, meta and chevron are cells of one grid (placed in OrderRowStatus), so the pill
                can sit on the meta line on phones and at the row's end from 735 px. */}
            <div
              className={cx(
                'grid min-h-16 min-w-0 flex-1 grid-cols-[auto_1fr_auto] content-center items-center gap-x-2 gap-y-1 py-3 pr-3',
                'sm:grid-cols-[1fr_auto_auto] sm:gap-x-3 sm:gap-y-0.5 sm:pr-4',
                index > 0 && 'border-separator border-t',
              )}
            >
              <p className="col-span-2 col-start-1 row-start-1 line-clamp-2 text-callout font-medium sm:col-span-1">
                <TitleText text={order.product.title} />
              </p>
              <OrderRowStatus
                status={order.status}
                createdAt={order.createdAt}
                expiresAt={order.expiresAt}
                serverNow={order.serverNow}
                total={formatMoney(order.totalCents, order.currency, 'exact')}
              />
              <ChevronRight size={16} className="col-start-3 row-span-2 row-start-1 text-label-tertiary" />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The list's exact box while it loads: `rows` rows of 64 px. */
export function OrderListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        // Index keys: placeholder rows never reorder.
        <div key={index} className="flex items-center gap-3 pl-4 sm:pl-5">
          <div className="skeleton size-10 shrink-0" />
          <div
            className={cx(
              'flex min-h-16 flex-1 items-center gap-3 py-3 pr-3 sm:pr-4',
              index > 0 && 'border-separator border-t',
            )}
          >
            <div className="flex-1">
              <SkeletonText style="callout" className="w-3/5" />
              <SkeletonText style="footnote" className="mt-0.5 w-2/5" />
            </div>
            <div className="skeleton h-6 w-20 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
