import { type DropInfo, type Product, type StockSnapshot, uploadPath } from '@flashdrop/contracts';
import { CalendarClock, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { productJsonLd, serializeJsonLd } from '../../lib/json-ld';
import { liveRoomHref, productHref } from '../../lib/routes';
import { getStock } from '../../lib/server/catalog';
import { log } from '../../lib/server/log';
import { requestOrigin } from '../../lib/server/request';
import { getViewer } from '../../lib/server/session';
import { describeStock, type StockState, toStockState } from '../../lib/stock';
import { Skeleton, SkeletonText } from '../ui/skeleton';
import { DropStatusPill } from '../ui/status-pill';
import { Countdown } from './countdown';
import { LiveBadge } from './live-badge';
import { LocalTime } from './local-time';
import { PurchasePanel } from './purchase-panel';
import { StockText } from './stock-text';

/*
 * The request-time parts of the product page (SD §8.1): they read the uncached stock snapshot, so the raw
 * HTML carries the current number, and the session, for the Buy button. Each sits in its own <Suspense>
 * hole inside the cached product shell; `getStock` is memoised per request, so they share one api read.
 */

/** The snapshot, or `null` when api cannot answer; the product shell around it still renders. */
async function readStock(drop: DropInfo): Promise<{ stock: StockState; serverNow: number } | null> {
  let snapshot: StockSnapshot;
  try {
    snapshot = await getStock(drop.id);
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error, dropId: drop.id }, 'stock snapshot unavailable');
    return null;
  }
  return { stock: toStockState(snapshot, drop.status), serverNow: Date.parse(snapshot.serverNow) };
}

/**
 * "[LIVE] Ends in 12:04" above the title (§10.2). A scheduled drop shows when it opens, as the home hero does,
 * and leaves the state to LiveStock's countdown and the Buy button: a "Scheduled" pill would only repeat them
 * (§1.4). Paused and ended drops show their status pill.
 */
export async function DropStatusLine({ drop }: { drop: DropInfo }) {
  const read = await readStock(drop);
  if (!read) return <DropStatusLineSkeleton />;
  const { stock, serverNow } = read;
  return (
    <div className="flex min-h-6 items-center gap-2 text-footnote text-label-secondary">
      {stock.status === 'LIVE' ? (
        <>
          <LiveBadge />
          <Countdown target={drop.endsAt} serverNow={serverNow} verb="Ends" />
        </>
      ) : stock.status === 'SCHEDULED' ? (
        <span className="inline-flex items-center gap-1.5">
          <CalendarClock size={16} />
          <LocalTime iso={drop.startsAt} />
        </span>
      ) : (
        <DropStatusPill status={stock.status} />
      )}
    </div>
  );
}

export function DropStatusLineSkeleton() {
  return <div aria-hidden="true" className="min-h-6" />;
}

type LivePurchaseProps = { product: Product; drop: DropInfo };

/**
 * LiveStock and the purchase panel (the row and its terms), plus the JSON-LD offer, all from one snapshot so
 * they always agree. Without a snapshot it says so in place of the stock and leaves the rest of the page as it is; the
 * JSON-LD then describes the product without an offer.
 */
export async function LivePurchase({ product, drop }: LivePurchaseProps) {
  const [read, viewer] = await Promise.all([readStock(drop), getViewer()]);
  if (!read) {
    return (
      <div className="mt-6">
        <p className="text-headline">Live stock is unavailable</p>
        <p className="mt-1 text-footnote text-label-secondary">Refresh the page in a moment to try again.</p>
        <ProductJsonLd product={product} offer={null} />
      </div>
    );
  }

  const { stock, serverNow } = read;
  const href = productHref(product.slug);
  const watchHref = liveRoomHref(drop.room);

  return (
    <>
      <StockText className="mt-6" stock={stock} startsAt={drop.startsAt} serverNow={serverNow} />
      <PurchasePanel
        stock={stock}
        perUserLimit={drop.perUserLimit}
        holdSeconds={drop.holdSeconds}
        startsAt={drop.startsAt}
        serverNow={serverNow}
        priceCents={drop.priceCents}
        currency={drop.currency}
        signedIn={viewer !== null}
        returnTo={href}
      />
      {watchHref && (
        <Link
          href={watchHref}
          className="mt-2 inline-flex min-h-11 items-center gap-1 text-callout text-accent-label"
        >
          Watch the live drop
          <ChevronRight size={14} />
        </Link>
      )}
      <ProductJsonLd product={product} offer={{ drop, stock }} />
    </>
  );
}

type ProductJsonLdProps = {
  product: Product;
  /** The drop and the snapshot the page shows, or `null` when there is no drop or no snapshot. */
  offer: { drop: DropInfo; stock: StockState } | null;
};

/** schema.org `Product`, with its `Offer` when the page shows one (SD §8.1). Absolute URLs from the request. */
export async function ProductJsonLd({ product, offer }: ProductJsonLdProps) {
  const origin = await requestOrigin();
  const data = productJsonLd({
    product,
    drop: offer?.drop ?? null,
    stock: offer?.stock ?? null,
    urgent: offer ? describeStock(offer.stock).urgent : false,
    pageUrl: new URL(productHref(product.slug), origin).href,
    imageUrls: product.imageKeys.map((key) => new URL(uploadPath(key), origin).href),
  });
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}

/** The exact box of LiveStock and the purchase row while the snapshot streams in (§9.16). */
export function LivePurchaseSkeleton() {
  return (
    <div aria-hidden="true">
      <SkeletonText style="headline" className="mt-6 w-28" />
      <SkeletonText style="footnote" className="mt-1 w-40" />
      <Skeleton className="mt-2 h-1.5 rounded-full" />
      <div className="mt-6 flex gap-3">
        <Skeleton className="h-14 flex-1 rounded-full" />
      </div>
      <SkeletonText style="footnote" className="mt-3 w-4/5" />
    </div>
  );
}
