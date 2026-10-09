import { uploadPath } from '@flashdrop/contracts';
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { LiveRoom } from '../../../components/live/live-room';
import { Skeleton, SkeletonText } from '../../../components/ui/skeleton';
import { NO_CLAIM } from '../../../lib/hold';
import { productHref } from '../../../lib/routes';
import { getRoom } from '../../../lib/server/catalog';
import { readViewerClaim } from '../../../lib/server/orders';
import { publicOrigin } from '../../../lib/server/origin';
import { getViewer } from '../../../lib/server/session';
import { getAboutDrop, getShow, getUpNext } from '../../../lib/server/show';
import { SITE_DESCRIPTION } from '../../../lib/site';

/*
 * The live room (design §8.1, design-system §10.3): an SSR shell with client islands. The room, its pinned
 * drop and that drop's stock are read uncached at request time, so the raw HTML carries the current number,
 * like the product page's; from then on the socket keeps the stock, the pinned drop and the viewer count
 * current. Around the player: the show's products in stream order, the pinned product's highlights and the
 * drops coming up, each from cached reads, and each left out when its read fails. Everything waits for the request's `params` inside Suspense, so `next build` never calls api. An
 * unknown slug gets its 404 from proxy.ts before this page's 200 shell is sent; notFound() here is the
 * fallback for a check that couldn't reach api.
 */

/** The room is always dark, so the browser's chrome is too (design-system §8.3). */
export const viewport: Viewport = { themeColor: '#161617' };

const roomHref = (slug: string) => `/live/${slug}`;

export async function generateMetadata({ params }: PageProps<'/live/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const [detail, origin] = await Promise.all([getRoom(slug), publicOrigin()]);
  if (!detail) notFound();
  const { room, drop } = detail;
  const description = drop ? `Live from ${room.title}: ${drop.product.title}.` : SITE_DESCRIPTION;
  const photo = drop?.product.imageKeys[0];
  return {
    title: room.title,
    description,
    metadataBase: new URL(origin),
    alternates: { canonical: roomHref(room.slug) },
    openGraph: {
      type: 'website',
      title: room.title,
      description,
      url: roomHref(room.slug),
      images: photo ? [{ url: uploadPath(photo) }] : [],
    },
  };
}

export default function LiveRoomPage({ params }: PageProps<'/live/[slug]'>) {
  return (
    <Suspense fallback={<LiveRoomSkeleton />}>
      <LiveRoomContent params={params} />
    </Suspense>
  );
}

async function LiveRoomContent({ params }: Pick<PageProps<'/live/[slug]'>, 'params'>) {
  const { slug } = await params;
  const [detail, viewer] = await Promise.all([getRoom(slug), getViewer()]);
  if (!detail) notFound();
  const { room, drop } = detail;
  const [claim, show, about, upNext] = await Promise.all([
    drop ? readViewerClaim(viewer, drop.id) : NO_CLAIM,
    getShow(room.hlsUrl),
    drop ? getAboutDrop(drop.product.slug) : null,
    getUpNext(room.slug, drop?.id ?? null),
  ]);
  const next = upNext?.drops[0];
  return (
    <LiveRoom
      room={room}
      drop={drop}
      serverNow={Date.now()}
      signedIn={viewer !== null}
      returnTo={roomHref(room.slug)}
      claim={claim}
      next={next ? { title: next.product.title, href: productHref(next.product.slug) } : null}
      show={show}
      about={about}
      upNext={upNext}
    />
  );
}

/** The room's exact box while it loads: the 16:9 player, the title lines and the drop card (§9.16). */
function LiveRoomSkeleton() {
  return (
    <div
      aria-busy="true"
      className="pb-12 sm:page-wide sm:pt-6 md:grid md:grid-cols-12 md:items-start md:gap-(--grid-gap) md:pt-8 md:pb-16"
    >
      <div aria-hidden="true" className="md:col-span-8">
        <Skeleton className="aspect-video rounded-none sm:rounded-xl" />
        <div className="max-sm:page-wide mt-4 sm:mt-5">
          <SkeletonText style="title-2" className="w-56" />
          <SkeletonText style="footnote" className="mt-1 w-48" />
        </div>
      </div>
      <div
        aria-hidden="true"
        className="max-sm:page-wide mt-6 sm:max-w-form md:col-span-4 md:mt-0 md:max-w-none"
      >
        <Skeleton className="h-74 rounded-lg" />
      </div>
    </div>
  );
}
