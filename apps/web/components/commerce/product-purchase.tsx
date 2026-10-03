import { type DropInfo, type Product, type StockSnapshot, uploadPath } from '@flashdrop/contracts';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { type HeldOrder, liveHold } from '../../lib/hold';
import { productJsonLd, serializeJsonLd } from '../../lib/json-ld';
import type { LiveLevel } from '../../lib/live-stock';
import { liveRoomHref, productHref } from '../../lib/routes';
import { getStock } from '../../lib/server/catalog';
import { log } from '../../lib/server/log';
import { readMyOrders } from '../../lib/server/orders';
import { requestOrigin } from '../../lib/server/request';
import { getViewer, type Viewer } from '../../lib/server/session';
import { describeStock, type StockState, toLiveSeed } from '../../lib/stock';
import { Skeleton, SkeletonText } from '../ui/skeleton';
import { LiveDropStatus } from './live-drop-status';
import { LivePurchasePanel } from './live-purchase-panel';

/*
 * The request-time parts of the product page (SD §8.1): they read the uncached stock snapshot, so the raw
 * HTML carries the current number, and the session, for the Buy button and the buyer's live hold on the drop.
 * Each sits in its own <Suspense>
 * hole inside the cached product shell; `getStock` is memoised per request, so they share one api read.
 * The snapshot seeds the drop's live stock store, which both islands then follow (SD §8.2).
 */

/** The snapshot, or `null` when api cannot answer; the product shell around it still renders. */
async function readStock(drop: DropInfo): Promise<{ stock: LiveLevel; serverNow: number } | null> {
  let snapshot: StockSnapshot;
  try {
    snapshot = await getStock(drop.id);
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error, dropId: drop.id }, 'stock snapshot unavailable');
    return null;
  }
  return { stock: toLiveSeed(snapshot, drop.status), serverNow: Date.parse(snapshot.serverNow) };
}

/** The status line above the title (§10.2), live from the snapshot on. */
export async function DropStatusLine({ drop }: { drop: DropInfo }) {
  const read = await readStock(drop);
  if (!read) return <DropStatusLineSkeleton />;
  return (
    <LiveDropStatus
      dropId={drop.id}
      seed={read.stock}
      startsAt={drop.startsAt}
      endsAt={drop.endsAt}
      serverNow={read.serverNow}
    />
  );
}

export function DropStatusLineSkeleton() {
  return <div aria-hidden="true" className="min-h-6" />;
}

/**
 * The most recent orders searched for a live hold on the drop. A hold lives a few minutes at most, so it is
 * always among a buyer's latest orders.
 */
const RECENT_ORDERS = 20;

/**
 * The signed-in viewer's live hold on the drop, which the panel offers back (§9.13), or `null`. Without one
 * the page still sells: an api that can't list orders right now costs only the reminder, and is logged.
 */
async function readHeldOrder(viewer: Viewer | null, dropId: string): Promise<HeldOrder | null> {
  if (viewer === null) return null;
  try {
    const read = await readMyOrders(RECENT_ORDERS);
    return read.kind === 'ok' ? liveHold(read.value, dropId) : null;
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error, dropId }, 'cannot list orders for the product page');
    return null;
  }
}

type LivePurchaseProps = { product: Product; drop: DropInfo };

/**
 * LiveStock and the purchase panel (the row and its terms), plus the JSON-LD offer, all from one snapshot so
 * they always agree. Without a snapshot it says so in place of the stock and leaves the rest of the page as it is; the
 * JSON-LD then describes the product without an offer.
 */
export async function LivePurchase({ product, drop }: LivePurchaseProps) {
  const viewer = await getViewer();
  const [read, heldOrder] = await Promise.all([readStock(drop), readHeldOrder(viewer, drop.id)]);
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
      <LivePurchasePanel
        dropId={drop.id}
        seed={stock}
        perUserLimit={drop.perUserLimit}
        holdSeconds={drop.holdSeconds}
        startsAt={drop.startsAt}
        serverNow={serverNow}
        priceCents={drop.priceCents}
        currency={drop.currency}
        signedIn={viewer !== null}
        returnTo={href}
        heldOrder={heldOrder}
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
