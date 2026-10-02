'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { useMediaQuery } from '../../lib/use-media-query';

/**
 * `sizes` of a gallery photo: at most 7 of 12 columns in `page-wide` (less on a short window, `gallery-fit`),
 * half the page on tablet, the full width on phone.
 */
const PHOTO_SIZES = '(min-width: 1069px) 690px, (min-width: 735px) calc(50vw - 42px), 100vw';

type ProductGalleryProps = {
  title: string;
  /** Same-origin `/uploads/<key>` paths, in display order. */
  photos: readonly string[];
};

/**
 * The product's photos (design-system §10.2) as one horizontal scroll-snap track at every width: a full-bleed
 * swipeable carousel with page dots on phones, and from 735 px a rounded photo with thumbnails, plus previous
 * and next buttons from 1069 px. Swiping, the buttons and the thumbnails all move the same track, so they can
 * never disagree about which photo is showing. The first photo is the page's one preloaded image (§11.4).
 * It fills the width the product layout gives it, which from 1069 px keeps the whole photo and the thumbnails
 * that say there are more in the first viewport (`gallery-fit`, §1.2).
 */
export function ProductGallery({ title, photos }: ProductGalleryProps) {
  const track = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const count = photos.length;

  // The slide that fills most of the track is the current one, however it got there.
  useEffect(() => {
    const root = track.current;
    if (!root || count < 2) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setCurrent(Number((entry.target as HTMLElement).dataset.index));
        }
      },
      { root, threshold: 0.6 },
    );
    for (const slide of root.children) observer.observe(slide);
    return () => observer.disconnect();
  }, [count]);

  function show(index: number): void {
    const root = track.current;
    const slide = root?.children[index];
    if (!root || !(slide instanceof HTMLElement)) return;
    root.scrollTo({ left: slide.offsetLeft, behavior: reduceMotion ? 'instant' : 'smooth' });
    setCurrent(index);
  }

  if (count === 0) {
    return <div className="aspect-4/5 bg-bg-secondary sm:rounded-lg" />;
  }

  return (
    <section aria-roledescription="carousel" aria-label={`Photos of ${title}`}>
      <div className="group relative">
        {/* The track is focusable, so the photos scroll with the arrow keys where there are no buttons (phones).
            A named group, not a second region inside the carousel's own. */}
        {/* biome-ignore lint/a11y/useSemanticElements: a scroll container, not a set of form controls. */}
        <div
          ref={track}
          role="group"
          aria-label="Photos"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be reachable by keyboard.
          tabIndex={0}
          className="scrollbar-none flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain sm:rounded-lg"
        >
          {photos.map((src, index) => (
            // biome-ignore lint/a11y/useSemanticElements: the APG carousel pattern marks each slide as a group.
            <div
              key={src}
              data-index={index}
              role="group"
              aria-roledescription="slide"
              aria-label={`${index + 1} of ${count}`}
              className="relative aspect-4/5 w-full shrink-0 snap-center snap-always bg-bg-secondary"
            >
              <Image
                src={src}
                alt={`${title}, photo ${index + 1} of ${count}`}
                fill
                sizes={PHOTO_SIZES}
                preload={index === 0}
                // A preload alone is fetched at low priority; the LCP photo should not wait behind scripts.
                fetchPriority={index === 0 ? 'high' : undefined}
                className="object-cover"
              />
            </div>
          ))}
        </div>
        {count > 1 && (
          <>
            <StepButton
              direction="previous"
              disabled={current === 0}
              onClick={() => show(Math.max(0, current - 1))}
            />
            <StepButton
              direction="next"
              disabled={current === count - 1}
              onClick={() => show(Math.min(count - 1, current + 1))}
            />
          </>
        )}
      </div>

      {count > 1 && (
        <>
          {/* Position only; the slides' labels carry it for assistive technology (§9.29). */}
          <div aria-hidden="true" className="mt-3 flex justify-center gap-2 sm:hidden">
            {photos.map((src, index) => (
              <span
                key={src}
                className={cx(
                  'size-2 rounded-full transition-colors duration-200 ease-standard',
                  index === current ? 'bg-label' : 'bg-label-tertiary',
                )}
              />
            ))}
          </div>
          <ul className="mt-4 hidden gap-2 sm:flex">
            {photos.map((src, index) => (
              <li key={src}>
                <button
                  type="button"
                  aria-label={`Show photo ${index + 1} of ${count}`}
                  aria-current={index === current || undefined}
                  onClick={() => show(index)}
                  className={cx(
                    'relative block size-16 overflow-clip rounded-sm bg-bg-secondary',
                    'transition-shadow duration-200 ease-standard',
                    index === current ? 'ring-2 ring-label' : 'hover:ring-2 hover:ring-separator',
                  )}
                >
                  <Image src={src} alt="" fill sizes="64px" className="object-cover" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The 44 px previous and next buttons over the photo, from 1069 px (§10.2). They appear while the gallery is
 * hovered or one of them has focus, on `material-thick`, so their icons are `label` (§2.5). At either end the
 * one that can't move shows at 40%, so it never looks clickable.
 */
function StepButton({
  direction,
  disabled,
  onClick,
}: {
  direction: 'previous' | 'next';
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = direction === 'previous' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={direction === 'previous' ? 'Previous photo' : 'Next photo'}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className={cx(
        'material-thick absolute top-1/2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full text-label elevation-2 md:flex',
        'opacity-0 transition-opacity duration-200 ease-standard',
        direction === 'previous' ? 'left-4' : 'right-4',
        // Exclusive sets: with both opacities in the class list, the stylesheet's order (100 after 40) would win.
        disabled
          ? 'cursor-default group-hover:opacity-40 focus-visible:opacity-40'
          : 'group-hover:opacity-100 focus-visible:opacity-100',
      )}
    >
      <Icon />
    </button>
  );
}
