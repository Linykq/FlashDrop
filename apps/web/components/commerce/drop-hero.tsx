import { type DropSummary, uploadPath } from '@flashdrop/contracts';
import { CalendarClock } from 'lucide-react';
import Image from 'next/image';
import { unstable_rethrow } from 'next/navigation';
import { Suspense } from 'react';
import { cx } from '../../lib/cx';
import { COUNTDOWN_WINDOW_MS } from '../../lib/format';
import { liveRoomHref, productHref } from '../../lib/routes';
import { getStock } from '../../lib/server/catalog';
import { log } from '../../lib/server/log';
import { toStockState } from '../../lib/stock';
import { ButtonLink } from '../ui/button';
import { Skeleton, SkeletonText } from '../ui/skeleton';
import { TitleText } from '../ui/title-text';
import { Countdown } from './countdown';
import { LiveBadge } from './live-badge';
import { LocalTime } from './local-time';
import { StockText } from './stock-text';

/** `sizes` of the hero photo: `page-form` (600 px) from 735 px, the page margins on phones (§11.4). */
const HERO_SIZES = '(min-width: 735px) 600px, calc(100vw - 40px)';

/**
 * Titles run from 10 to 80 characters, so the headline steps down with length and is never truncated; that
 * keeps the photo's top edge above the fold at 1440 × 900 and 390 × 844 (§10.1).
 */
function headlineClass(title: string): string {
  if (title.length <= 24) return 'text-display-1';
  if (title.length <= 40) return 'text-display-2';
  return 'text-title-1';
}

type DropHeroProps = {
  drop: DropSummary;
  /** The hero's intro line, from the product's description (`introSentence`). */
  intro: string | null;
  serverNow: number;
};

/**
 * The home hero (design-system §10.1): one drop, centred, on a full-bleed `bg-secondary` band, with its photo
 * as the page's one preloaded image. A LIVE drop leads with the LIVE badge, its closing countdown, Buy and
 * the live stock; a scheduled one with its opening time and, under 24 hours, a countdown.
 */
export function DropHero({ drop, intro, serverNow }: DropHeroProps) {
  const { product } = drop;
  const live = drop.status === 'LIVE';
  const opensSoon = Date.parse(drop.startsAt) - serverNow < COUNTDOWN_WINDOW_MS;
  const watchHref = live ? liveRoomHref(drop.room) : null;
  const photo = product.imageKeys[0];

  return (
    <section aria-labelledby="hero-title" className="bg-bg-secondary py-(--section-space)">
      <div className="page-wide flex flex-col items-center text-center">
        <p className="flex min-h-6 items-center gap-2 text-footnote text-label-secondary">
          {live ? (
            <>
              <LiveBadge pulse />
              <Countdown target={drop.endsAt} serverNow={serverNow} verb="Ends" />
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock size={16} />
              <LocalTime iso={drop.startsAt} />
            </span>
          )}
        </p>
        <h1 id="hero-title" className={cx('mt-4', headlineClass(product.title))}>
          <TitleText text={product.title} />
        </h1>
        {intro && <p className="mt-4 max-w-text text-intro text-label-secondary">{intro}</p>}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
          {!live && opensSoon && (
            <span className="text-callout text-label-secondary">
              <Countdown target={drop.startsAt} serverNow={serverNow} verb="Starts" variant="hero" />
            </span>
          )}
          <div className="flex gap-3">
            <ButtonLink href={productHref(product.slug)} size="lg">
              {live ? 'Buy' : 'View drop'}
            </ButtonLink>
            {watchHref && (
              <ButtonLink href={watchHref} variant="tinted" size="lg">
                Watch live
              </ButtonLink>
            )}
          </div>
        </div>

        {live && (
          <Suspense fallback={<HeroStockSkeleton />}>
            <HeroStock drop={drop} serverNow={serverNow} />
          </Suspense>
        )}

        {photo && (
          <div className="relative mt-12 aspect-4/5 w-full overflow-clip rounded-xl bg-bg sm:aspect-square sm:max-w-form">
            {/* A preload alone is fetched at low priority; the LCP photo should not wait behind scripts. */}
            <Image
              src={uploadPath(photo)}
              alt=""
              fill
              preload
              fetchPriority="high"
              sizes={HERO_SIZES}
              className="object-cover"
            />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The hero's stock line, read uncached at request time like the product page's, because the list it came
 * from is cached for minutes. If api cannot answer, the list's own (slightly older) numbers stand in.
 */
async function HeroStock({ drop, serverNow }: { drop: DropSummary; serverNow: number }) {
  let stock = toStockState(drop.stock, drop.status);
  try {
    const snapshot = await getStock(drop.id);
    stock = toStockState(snapshot, drop.status);
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error, dropId: drop.id }, 'hero stock snapshot unavailable; showing the cached list');
  }
  return (
    <StockText
      className="mt-6 w-full"
      layout="compact"
      stock={stock}
      startsAt={drop.startsAt}
      serverNow={serverNow}
    />
  );
}

function HeroStockSkeleton() {
  return (
    <div aria-hidden="true" className="mt-6 flex w-full flex-col items-center">
      <SkeletonText style="headline" className="w-64" />
      <Skeleton className="mt-2 h-1.5 w-full max-w-90 rounded-full" />
    </div>
  );
}

/** The hero's box while the drops load (§9.16): status line, headline, intro, actions, stock and photo. */
export function DropHeroSkeleton() {
  return (
    <div aria-hidden="true" className="bg-bg-secondary py-(--section-space)">
      <div className="page-wide flex flex-col items-center">
        <SkeletonText style="footnote" className="w-40" />
        <SkeletonText style="display-2" className="mt-4 w-3/4 max-w-form" />
        <SkeletonText style="intro" className="mt-4 w-2/3 max-w-text" />
        <Skeleton className="mt-6 h-14 w-28 rounded-full" />
        <HeroStockSkeleton />
        <Skeleton className="mt-12 aspect-4/5 w-full rounded-xl sm:aspect-square sm:max-w-form" />
      </div>
    </div>
  );
}

/** No drop to feature (§10.1): said calmly, without an icon, in the hero's own band. */
export function EmptyHero() {
  return (
    <section aria-labelledby="hero-title" className="bg-bg-secondary py-(--section-space)">
      <div className="page-wide flex flex-col items-center text-center">
        <h1 id="hero-title" className="text-display-2">
          No drops right now
        </h1>
        <p className="mt-4 max-w-text text-intro text-label-secondary">
          New drops show up here. Check back soon.
        </p>
      </div>
    </section>
  );
}
