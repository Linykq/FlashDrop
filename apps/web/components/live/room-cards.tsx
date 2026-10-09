'use client';

import { uploadPath } from '@flashdrop/contracts';
import { Check, ChevronRight } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useId } from 'react';
import { cx } from '../../lib/cx';
import { productHref } from '../../lib/routes';
import type { AboutDrop, UpNext } from '../../lib/server/show';
import { Countdown } from '../commerce/countdown';
import { Button } from '../ui/button';

/*
 * The live room's content beside and under the player (design-system §10.3): what the pinned drop is, what
 * comes next, and what is being said for the many who watch muted. Each is a plain card or section, never a
 * live region: the stream moves on every few seconds, and nothing here is worth interrupting for (§13.3).
 */

const cardClass = 'rounded-lg bg-surface p-5 elevation-1 sm:p-6';

/** "About this drop": the pinned product's highlights and its first paragraph, then the way to the rest. */
export function AboutThisDrop({ about, className }: { about: AboutDrop; className?: string }) {
  return (
    <section aria-labelledby="about-drop" className={className}>
      <h2 id="about-drop" className="text-title-3">
        About this drop
      </h2>
      {about.highlights.length > 0 && (
        <ul className="mt-4 flex max-w-text flex-col gap-3">
          {about.highlights.map((highlight) => (
            <li key={highlight} className="flex gap-3">
              <Check className="mt-0.5 shrink-0 text-label-secondary" />
              {highlight}
            </li>
          ))}
        </ul>
      )}
      {about.paragraph && <p className="mt-4 max-w-text text-label-secondary">{about.paragraph}</p>}
      <Link
        href={about.href}
        className="mt-2 inline-flex min-h-11 items-center gap-1 text-callout text-accent-label"
      >
        See full details
        <ChevronRight size={14} />
      </Link>
    </section>
  );
}

/**
 * "Up next in {room}": up to three drops that follow, each with its thumbnail and when it opens, a countdown
 * under 24 hours. "More drops" from the whole catalog when the room has nothing scheduled.
 */
export function UpNextCard({
  upNext,
  roomTitle,
  serverNow,
  className,
}: {
  upNext: UpNext;
  roomTitle: string;
  serverNow: number;
  className?: string;
}) {
  // The room renders it in one of two places by width (the other `display: none`), so its id is its own.
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cx(cardClass, className)}>
      <h2 id={titleId} className="text-headline">
        {upNext.scope === 'room' ? `Up next in ${roomTitle}` : 'More drops'}
      </h2>
      <ul className="mt-3 flex flex-col">
        {upNext.drops.map((drop) => {
          const photo = drop.product.imageKeys[0];
          return (
            <li key={drop.id} className="border-separator not-first:border-t">
              <Link href={productHref(drop.product.slug)} className="flex min-h-16 items-center gap-3 py-2">
                <span className="relative size-12 shrink-0 overflow-clip rounded-sm bg-bg-secondary">
                  {photo && (
                    <Image src={uploadPath(photo)} alt="" fill sizes="48px" className="object-cover" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-callout font-medium">{drop.product.title}</span>
                  <span className="block text-footnote text-label-secondary">
                    <Countdown target={drop.startsAt} serverNow={serverNow} verb="Starts" />
                  </span>
                </span>
                <ChevronRight size={16} className="shrink-0 text-label-tertiary" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * "What's being said": the last lines of the stream's captions, for the many who watch muted (autoplay is
 * muted, §10.3) without captions on. Not a live region: the captions track itself is the accessible
 * version, and its toggle is right here.
 */
export function SaidCard({
  lines,
  captions,
  onToggleCaptions,
  className,
}: {
  /** Oldest first; the last is the one being said now. */
  lines: readonly string[];
  captions: boolean;
  onToggleCaptions: () => void;
  className?: string;
}) {
  return (
    <section aria-labelledby="said" className={cx(cardClass, className)}>
      <h2 id="said" className="text-headline">
        What's being said
      </h2>
      <ol className="mt-3 flex flex-col gap-2 text-callout">
        {lines.map((line, index) => (
          <li
            key={`${index}:${line}`}
            className={index === lines.length - 1 ? 'text-label' : 'text-label-secondary'}
          >
            {line}
          </li>
        ))}
      </ol>
      <Button variant="plain" size="sm" onClick={onToggleCaptions} className="mt-3 -ml-3">
        {captions ? 'Turn off captions' : 'Turn on captions'}
      </Button>
    </section>
  );
}
