import Image, { type StaticImageData } from 'next/image';
import Link from 'next/link';
import { cx } from '../../lib/cx';
import { describeStock, type StockState } from '../../lib/stock';
import { Skeleton, SkeletonText } from '../ui/skeleton';
import { TitleText } from '../ui/title-text';
import { Countdown } from './countdown';
import { LiveBadge } from './live-badge';
import { Price } from './price';

/** `sizes` for a tile photo: 3 columns of 384 px in `page-wide`, 2 on tablet, 1 on phone (§11.4). */
const TILE_SIZES = '(min-width: 1069px) 384px, (min-width: 735px) calc(50vw - 42px), calc(100vw - 40px)';

type ProductTileProps = {
  href: string;
  title: string;
  /** A same-origin `/uploads/<key>` path or a static import; `null` leaves the empty well. */
  image: string | StaticImageData | null;
  priceCents: number;
  currency: string;
  stock: StockState;
  startsAt: string;
  serverNow: number;
};

/**
 * One drop in a grid (§9.7): an `<article>` that is a single tab stop, because its title link stretches over
 * the whole tile. The photo has empty alt text: the title right below names it. The article is a size
 * container so the link's scroll margin can reach up over the well (see below).
 */
export function ProductTile({
  href,
  title,
  image,
  priceCents,
  currency,
  stock,
  startsAt,
  serverNow,
}: ProductTileProps) {
  const view = describeStock(stock);
  // Tiles say "Ended" where the purchase panel says "Drop ended": the tile is the drop.
  const meta = stock.status === 'ENDED' ? 'Ended' : view.primary;

  return (
    <article className="group @container relative hover:z-(--z-raised)">
      <div
        className={cx(
          'relative aspect-4/5 overflow-clip rounded-lg bg-bg-secondary',
          // The well alone lifts on hover; the photo never scales and the text below never moves (§6.4).
          'transition-[box-shadow,scale] duration-200 ease-out group-hover:duration-300 group-hover:elevation-2',
          'motion-safe:group-active:scale-98 motion-safe:group-active:duration-100',
          // The link draws no ring of its own: the well shows the focus ring for the whole tile.
          'group-has-[a:focus-visible]:outline-3 group-has-[a:focus-visible]:outline-focus group-has-[a:focus-visible]:outline-offset-2',
        )}
      >
        {image && <Image src={image} alt="" fill sizes={TILE_SIZES} className="object-cover" />}
        {stock.status === 'LIVE' && (
          <div className="absolute top-3 left-3">
            <LiveBadge size="sm" />
          </div>
        )}
      </div>
      <p
        className={cx(
          'mt-4 text-footnote tabular-nums',
          view.urgent ? 'text-danger' : 'text-label-secondary',
        )}
      >
        {meta ?? <Countdown target={startsAt} serverNow={serverNow} verb="Starts" />}
      </p>
      <h3 className="mt-1 line-clamp-2 text-title-3">
        {/* Focus scrolls only the link's own box into view, and the stretched ::after isn't part of it. The
            margin covers what sits above the link: the 3 px ring 2 px out, the 4:5 well (125% of the tile's
            width), 16 px, the 18 px meta line and 4 px, so the ring never ends up under the bar (§4.5). */}
        <Link
          href={href}
          className="scroll-mt-[calc(125cqi+2.75rem)] after:absolute after:inset-0 focus-visible:outline-none"
        >
          <TitleText text={title} />
        </Link>
      </h3>
      <p className="mt-1">
        <Price cents={priceCents} currency={currency} />
      </p>
    </article>
  );
}

/** The tile's exact box while it loads: the 4:5 well and three bars at the footnote, title-3 and body lines. */
export function ProductTileSkeleton() {
  return (
    <div aria-hidden="true">
      <Skeleton className="aspect-4/5 rounded-lg" />
      <SkeletonText style="footnote" className="mt-4 w-24" />
      <SkeletonText style="title-3" className="mt-1 w-7/10" />
      <SkeletonText style="body" className="mt-1 w-12" />
    </div>
  );
}
