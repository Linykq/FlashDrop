import { type DropSummary, uploadPath } from '@flashdrop/contracts';
import type { Metadata } from 'next';
import { io } from 'next/cache';
import { Suspense } from 'react';
import { DropHero, DropHeroSkeleton, EmptyHero } from '../../components/commerce/drop-hero';
import { ProductTile, ProductTileSkeleton } from '../../components/commerce/product-tile';
import { SkeletonText } from '../../components/ui/skeleton';
import { productHref } from '../../lib/routes';
import { getDrops, getProduct } from '../../lib/server/catalog';
import { requestOrigin } from '../../lib/server/request';
import { SITE_DESCRIPTION, SITE_NAME } from '../../lib/site';
import { toStockState } from '../../lib/stock';
import { introSentence } from '../../lib/text';

const TITLE = 'Drops';

/** The canonical URL and the share card; absolute URLs need the request's origin (as on the product page). */
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: TITLE,
    metadataBase: new URL(await requestOrigin()),
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title: TITLE,
      description: SITE_DESCRIPTION,
      url: '/',
    },
  };
}

/** At most this many tiles under the hero (§10.1). */
const MAX_UPCOMING = 9;

/*
 * Home (design §8.1, design-system §10.1): request time, then cached under the `drops` tag. `io()` keeps
 * the catalog read out of `next build`, where no api exists, and lets the clock be read for the countdowns.
 */
export default function HomePage() {
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  await io();
  const open = await getDrops(['LIVE', 'PAUSED', 'SCHEDULED'], 20);
  const serverNow = Date.now();

  // The LIVE drop that started first, otherwise the next scheduled one (api lists LIVE first, by start).
  const hero =
    open.find((drop) => drop.status === 'LIVE') ?? open.find((drop) => drop.status === 'SCHEDULED');
  // Ended drops aren't listed (§10.1): nothing there can be bought, and their pages stay reachable by URL.
  const upcoming = rankUpcoming(open.filter((drop) => drop !== hero)).slice(0, MAX_UPCOMING);
  const intro = hero ? await heroIntro(hero) : null;

  return (
    <>
      {hero ? <DropHero drop={hero} intro={intro} serverNow={serverNow} /> : <EmptyHero />}
      {upcoming.length > 0 && (
        <DropSection id="upcoming" title="Upcoming drops" drops={upcoming} serverNow={serverNow} />
      )}
    </>
  );
}

/** Other LIVE drops first, then paused ones, then the scheduled ones by start time (§10.1). */
function rankUpcoming(drops: readonly DropSummary[]): DropSummary[] {
  const rank = { LIVE: 0, PAUSED: 1, SCHEDULED: 2, ENDED: 3 } as const;
  return drops.toSorted(
    (a, b) => rank[a.status] - rank[b.status] || Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
}

/** The hero's intro line from the featured product's description, from the cached product read. */
async function heroIntro(drop: DropSummary): Promise<string | null> {
  const detail = await getProduct(drop.product.slug);
  return detail ? introSentence(detail.product.description, detail.product.title) : null;
}

type DropSectionProps = {
  id: string;
  title: string;
  drops: readonly DropSummary[];
  serverNow: number;
};

function DropSection({ id, title, drops, serverNow }: DropSectionProps) {
  return (
    <section aria-labelledby={id}>
      <div className="page-wide py-(--section-space)">
        <h2 id={id} className="text-title-1">
          {title}
        </h2>
        <ul className="mt-6 grid gap-x-(--grid-gap) gap-y-12 sm:mt-8 sm:grid-cols-2 md:grid-cols-3">
          {drops.map((drop) => (
            <li key={drop.id}>
              <ProductTile
                href={productHref(drop.product.slug)}
                title={drop.product.title}
                image={drop.product.imageKeys[0] ? uploadPath(drop.product.imageKeys[0]) : null}
                priceCents={drop.priceCents}
                currency={drop.currency}
                stock={toStockState(drop.stock, drop.status)}
                startsAt={drop.startsAt}
                serverNow={serverNow}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function HomeSkeleton() {
  return (
    <div aria-busy="true">
      <DropHeroSkeleton />
      <div aria-hidden="true" className="page-wide py-(--section-space)">
        <SkeletonText style="title-1" className="w-64" />
        <div className="mt-6 grid gap-x-(--grid-gap) gap-y-12 sm:mt-8 sm:grid-cols-2 md:grid-cols-3">
          <ProductTileSkeleton />
          <ProductTileSkeleton />
          <ProductTileSkeleton />
        </div>
      </div>
    </div>
  );
}
