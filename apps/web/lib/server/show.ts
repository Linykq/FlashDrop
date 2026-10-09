import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DropSummary } from '@flashdrop/contracts';
import type { PublicDropStatus } from '@flashdrop/domain';
import { cacheLife } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { type Cue, parseCues, segmentSlugs } from '../captions';
import { productHref } from '../routes';
import { streamAssets } from '../stream';
import { getDrops, getProduct } from './catalog';
import { log } from './log';

/*
 * What the live room shows around its player (design-system §10.3): the products of the show, in the order the
 * stream presents them (its captions' cue ids are product slugs, SD §8.1), the pinned product's highlights,
 * and the drops coming up. Everything here is extra: a read that fails leaves its part out, never the room.
 */

/** A product the show presents, with what its own drop is doing. */
export type ShowSegment = {
  slug: string;
  title: string;
  href: string;
  imageKey: string | null;
  drop: { status: PublicDropStatus; startsAt: string; priceCents: number; currency: string } | null;
};

export type Show = { segments: ShowSegment[]; cues: Cue[] };

const CAPTIONS_TIMEOUT_MS = 2_000;

/**
 * The captions file of a room's stream: a same-origin path is read from web's own `public/` (the sample
 * stream, SD §8.1), whose directory is web's working directory in dev and in the standalone image alike; an
 * https stream's is fetched. Kept for hours: a stream's captions don't change.
 */
async function readCaptions(hlsUrl: string): Promise<string | null> {
  'use cache';
  cacheLife('hours');
  const { captions } = streamAssets(hlsUrl);
  if (captions.startsWith('/')) {
    const root = path.resolve(process.cwd(), 'public');
    const file = path.resolve(root, `.${captions}`);
    // The room's URL is admin data: it never reads outside public/.
    if (!file.startsWith(`${root}${path.sep}`)) return null;
    return readFile(file, 'utf8').catch(() => null);
  }
  const response = await fetch(captions, { signal: AbortSignal.timeout(CAPTIONS_TIMEOUT_MS) }).catch(
    () => null,
  );
  return response?.ok ? response.text() : null;
}

/** The show of a room's stream, or `null` when its captions can't be read or name no products. */
export async function getShow(hlsUrl: string): Promise<Show | null> {
  try {
    const vtt = await readCaptions(hlsUrl);
    if (vtt === null) return null;
    const cues = parseCues(vtt);
    const details = await Promise.all(segmentSlugs(cues).map((slug) => getProduct(slug)));
    const segments = details.flatMap((detail): ShowSegment[] => {
      if (detail === null) return [];
      const { product, drop } = detail;
      return [
        {
          slug: product.slug,
          title: product.title,
          href: productHref(product.slug),
          imageKey: product.imageKeys[0] ?? null,
          drop: drop && {
            status: drop.status,
            startsAt: drop.startsAt,
            priceCents: drop.priceCents,
            currency: drop.currency,
          },
        },
      ];
    });
    return segments.length > 0 ? { segments, cues } : null;
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error, hlsUrl }, 'cannot read the show of a stream; the room shows the player alone');
    return null;
  }
}

/** The pinned product's own words for "About this drop": its highlights and the first paragraph. */
export type AboutDrop = { highlights: string[]; paragraph: string | null; href: string };

export async function getAboutDrop(slug: string): Promise<AboutDrop | null> {
  try {
    const detail = await getProduct(slug);
    if (detail === null) return null;
    const { highlights } = detail.product.attributes;
    const paragraph = detail.product.description.split(/\n\s*\n/)[0]?.trim() || null;
    if (highlights.length === 0 && paragraph === null) return null;
    return { highlights, paragraph, href: productHref(slug) };
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error, slug }, 'cannot read the pinned product for the live room');
    return null;
  }
}

/** The drops after the pinned one: this room's, or every scheduled one when the room has none. */
export type UpNext = { scope: 'room' | 'all'; drops: DropSummary[] };

const UP_NEXT = 3;

export async function getUpNext(roomSlug: string, pinnedId: string | null): Promise<UpNext | null> {
  try {
    const scheduled = (await getDrops(['SCHEDULED'], 20)).filter((drop) => drop.id !== pinnedId);
    const inRoom = scheduled.filter((drop) => drop.room?.slug === roomSlug);
    if (inRoom.length > 0) return { scope: 'room', drops: inRoom.slice(0, UP_NEXT) };
    return scheduled.length > 0 ? { scope: 'all', drops: scheduled.slice(0, UP_NEXT) } : null;
  } catch (error) {
    unstable_rethrow(error);
    log().warn({ err: error, roomSlug }, 'cannot list scheduled drops for the live room');
    return null;
  }
}
