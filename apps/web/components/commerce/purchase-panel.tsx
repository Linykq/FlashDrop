'use client';

import {
  ChevronRight,
  CircleMinus,
  CircleX,
  Hourglass,
  Info,
  type LucideIcon,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, type RefObject, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { formatCount, formatDuration } from '../../lib/format';
import type { HeldOrder } from '../../lib/hold';
import { buyAction, maxQuantity } from '../../lib/purchase';
import { type ReserveNote, type ReserveNoteTone, reserveNote } from '../../lib/reserve-copy';
import { pendingQuantity } from '../../lib/reserve-key';
import { checkoutHref } from '../../lib/routes';
import { describeStock, type StockState } from '../../lib/stock';
import { useMediaQuery } from '../../lib/use-media-query';
import { type ReserveProblem, useReserve } from '../../lib/use-reserve';
import { announce } from '../ui/announcer';
import { ButtonLink } from '../ui/button';
import { QuantityStepper } from '../ui/quantity-stepper';
import { BuyButton } from './buy-button';
import { HeldOrderNotice } from './held-order-notice';
import { Price } from './price';

type PurchasePanelProps = {
  dropId: string;
  stock: StockState;
  perUserLimit: number;
  holdSeconds: number;
  startsAt: string;
  serverNow: number;
  priceCents: number;
  currency: string;
  signedIn: boolean;
  /** This product page, to come back to after signing in. */
  returnTo: string;
  /** The viewer's live hold on this drop when the page was rendered (§9.13), or `null`. */
  heldOrder: HeldOrder | null;
};

/**
 * The purchase row of the product page (§10.2): the buyer's live hold if they have one, the quantity stepper
 * and the Buy button, the note a press can leave under them, the terms, and on phones the sticky buy bar that
 * takes over while the row is not wholly on screen, so an available purchase action is always reachable
 * without scrolling (§1.1). Renders nothing once the drop ended, unless the buyer still holds some of it.
 */
export function PurchasePanel({
  dropId,
  stock,
  perUserLimit,
  holdSeconds,
  startsAt,
  serverNow,
  priceCents,
  currency,
  signedIn,
  returnTo,
  heldOrder,
}: PurchasePanelProps) {
  const [endedHold, setEndedHold] = useState<string | null>(null);
  const held = heldOrder !== null && heldOrder.id !== endedHold ? heldOrder : null;
  // The hold already takes the whole limit: the filled action leads back to it, never to a press api refuses.
  const atLimit = held !== null && held.qty >= perUserLimit;
  // What the buyer may still add beside the hold. With 1 there is nothing to choose: no stepper (§9.6).
  const room = Math.max(1, perUserLimit - (held?.qty ?? 0));

  const action = buyAction(stock, signedIn);
  const max = maxQuantity(stock, room);
  const [quantity, setQuantity] = useState(1);
  const { state, buy, dismiss } = useReserve(dropId, returnTo, { prefetch: action.kind === 'buy' });
  const row = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const inlineBuy = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const noteId = useId();
  const pressedIn = useRef<'row' | 'bar'>('row');
  const rowInView = useWhollyInView(row);
  const phone = useMediaQuery('(width < 735px)');

  // After a reload, offer the unfinished request again: the same quantity reuses its key and replays it.
  useEffect(() => {
    const pending = pendingQuantity(dropId);
    if (pending !== null) setQuantity(pending);
  }, [dropId]);

  // Next reveals a page it kept in a hidden <Activity> (Back, "Leave checkout", "Try again") as it was left,
  // without asking the server again, and its effects run again. The hold the buyer comes back from is server
  // data, so a revealed panel asks for the page again; the router keeps this one on screen until it arrives.
  const router = useRouter();
  const away = useRef(false);
  useEffect(() => {
    if (away.current) router.refresh();
    away.current = false;
    // Marked a task later, so React's development-only remount, cleanup and setup in one go, isn't a return.
    return () => {
      setTimeout(() => {
        away.current = true;
      }, 0);
    };
  }, [router]);

  const barShown = !rowInView;
  const noteFor = (problem: ReserveProblem) => reserveNote(problem, { perUserLimit, stock });
  // A note follows the buyer's own press, so it is announced once, politely, and brought into view: under a
  // button at the bottom edge it would start below the fold, and a press in the buy bar leaves the whole row
  // out of view. `nearest` leaves a note that is already visible where it is. Its stock was refreshed before
  // it was set (`useReserve`), so it is worded from the current level.
  const showNote = useEffectEvent((problem: ReserveProblem) => {
    // "We set your quantity to 1": the stepper takes what is left, and keeps it once more come back.
    if (
      problem.kind === 'refused' &&
      problem.code === 'SOLD_OUT' &&
      stock.avail > 0 &&
      stock.avail < problem.qty
    ) {
      setQuantity(stock.avail);
    }
    announce(noteFor(problem).text);
    // Pressed in the buy bar: bringing the note into view hides the bar and makes it inert, and a refusal
    // that closes the drop unmounts it, so focus would fall to the page (WCAG 2.4.3). It moves first to the
    // row's own button, which the note describes. Focus the buyer moved elsewhere meanwhile stays put.
    const active = document.activeElement;
    if (
      pressedIn.current === 'bar' &&
      (active === null || active === document.body || bar.current?.contains(active))
    ) {
      inlineBuy.current?.focus({ preventScroll: true });
    }
    noteRef.current?.scrollIntoView({ block: barShown ? 'center' : 'nearest', behavior: smoothScroll() });
  });
  useEffect(() => {
    if (state.problem) showNote(state.problem);
  }, [state.problem]);

  // A SOLD_OUT note words the stock at the refusal. Once units come back it no longer holds, and Buy, enabled
  // again, says the rest.
  const lastAvail = useRef(stock.avail);
  const onAvailChange = useEffectEvent((avail: number) => {
    const rose = avail > lastAvail.current;
    lastAvail.current = avail;
    if (rose && state.problem?.kind === 'refused' && state.problem.code === 'SOLD_OUT') dismiss();
  });
  useEffect(() => {
    onAvailChange(stock.avail);
  }, [stock.avail]);

  const heldNotice = (link: boolean) =>
    held && (
      <HeldOrderNotice
        order={held}
        serverNow={serverNow}
        link={link}
        onEnd={() => setEndedHold(held.id)}
        className="mt-6"
      />
    );

  // An ended drop has no Buy row, but a hold made before the end can still check out.
  if (action.kind === 'hidden') return heldNotice(true);
  const busy = state.phase !== 'idle';
  // The stepper sits only beside the button that reserves the chosen quantity: signed out, the choice would
  // be lost on the way through sign-in. It stays (locked) while its quantity is being reserved.
  const choosing = (action.kind === 'buy' && !atLimit) || busy;
  const chosen = Math.min(quantity, max);
  // The bar keeps an available action within reach; a closed state has none, so it never pins a dead button.
  const actionable = action.kind !== 'closed' || busy || atLimit;
  const button = {
    action,
    reserve: state,
    quantity: chosen,
    maxQuantity: max,
    startsAt,
    serverNow,
    returnTo,
  };
  const press = (from: 'row' | 'bar') => {
    pressedIn.current = from;
    buy(chosen);
  };
  const toCheckout = (size: 'lg' | 'md', className?: string) =>
    held && (
      <ButtonLink href={checkoutHref(held.id)} size={size} className={className}>
        Go to checkout
      </ButtonLink>
    );
  const noteAction =
    held && state.problem?.kind === 'refused' && state.problem.code === 'LIMIT_REACHED' ? (
      <Link href={checkoutHref(held.id)} className="inline-flex items-center gap-0.5 text-accent-label">
        Go to checkout
        <ChevronRight size={14} />
      </Link>
    ) : null;

  return (
    <>
      {heldNotice(!atLimit)}
      {/* A label longer than the room beside the stepper wraps the button onto its own full-width line. */}
      <div ref={row} className={cx(held ? 'mt-3' : 'mt-6', 'flex flex-wrap items-center gap-3')}>
        {choosing && (
          <QuantityStepper
            value={chosen}
            max={max}
            limit={room}
            size="lg"
            disabled={busy}
            onChange={(next) => {
              setQuantity(next);
              dismiss();
            }}
          />
        )}
        {atLimit && !busy ? (
          toCheckout('lg', 'min-w-fit flex-1')
        ) : (
          <BuyButton
            {...button}
            onBuy={() => press('row')}
            buttonRef={inlineBuy}
            describedBy={state.problem ? noteId : undefined}
            className="min-w-fit flex-1"
          />
        )}
      </div>
      {state.problem && (
        <ReserveNoteLine id={noteId} ref={noteRef} note={noteFor(state.problem)} action={noteAction} />
      )}
      {/* One footnote under the row, so there is one rhythm below the button. */}
      <p className="mt-3 text-footnote text-label-secondary">
        Limit {formatCount(perUserLimit)} per person. We hold your item for {formatDuration(holdSeconds)} at
        checkout.
      </p>
      {phone && actionable && (
        // Mounted while there is an action to keep in reach, so it fades both ways as the row leaves and
        // returns (200 ms, §6.4). `data-bottom-bar` is present only while it shows: base.css then reserves its
        // height below the page and in the scroll padding (§4.5).
        <div
          ref={bar}
          data-bottom-bar={barShown || undefined}
          inert={!barShown}
          className={cx(
            'material-bar fixed inset-x-0 bottom-0 z-(--z-sticky) border-separator border-t pb-[env(safe-area-inset-bottom)]',
            'transition-[opacity,visibility] duration-200',
            barShown ? 'visible opacity-100 ease-out' : 'invisible opacity-0 ease-in',
          )}
        >
          <div className="page-wide flex h-18 items-center justify-between gap-4">
            {/* Everything on the material is `label`: "Only" carries urgency, never colour (§2.5, §9.9). */}
            <div className="min-w-0 text-label">
              <p className="text-headline">
                <Price cents={priceCents} currency={currency} />
              </p>
              <p className="text-footnote tabular-nums">{describeStock(stock).primary}</p>
            </div>
            {atLimit && !busy ? (
              toCheckout('md')
            ) : (
              <BuyButton {...button} onBuy={() => press('bar')} size="md" />
            )}
          </div>
        </div>
      )}
    </>
  );
}

const glyphs: Record<ReserveNote['glyph'], LucideIcon> = {
  'not-reserved': CircleMinus,
  info: Info,
  expired: Hourglass,
  warning: TriangleAlert,
  error: CircleX,
  offline: WifiOff,
};

const toneClass: Record<ReserveNoteTone, { text: string; icon: string }> = {
  neutral: { text: 'text-label', icon: 'text-label-secondary' },
  warning: { text: 'text-label', icon: 'text-warning' },
  danger: { text: 'text-danger', icon: 'text-danger' },
};

type ReserveNoteLineProps = {
  id: string;
  note: ReserveNote;
  /** The next step, when there is one to link to ("Go to checkout" after the limit). */
  action: ReactNode;
  ref: RefObject<HTMLParagraphElement | null>;
};

/**
 * Why the last press did not reserve (§9.13), under the button until the buyer acts again. Not a live
 * region: the panel announces it once, politely, through the Announcer. The inline Buy button points at it
 * with `aria-describedby`, so the reason is read with the control.
 */
function ReserveNoteLine({ id, note, action, ref }: ReserveNoteLineProps) {
  const Icon = glyphs[note.glyph];
  const tone = toneClass[note.tone];
  return (
    <p ref={ref} className={cx('mt-4 flex animate-fade-in items-start gap-1.5 text-callout', tone.text)}>
      {/* 16 px beside 20 px lines: 2 px down centres it on the first line. */}
      <Icon size={16} className={cx('mt-0.5 shrink-0', tone.icon)} />
      <span>
        <span id={id}>{note.text}</span>
        {action && <> {action}</>}
      </span>
    </p>
  );
}

function smoothScroll(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/**
 * Whether the whole element is on screen below the navigation bar; `true` until measured, so SSR shows no
 * bar. A row that is cut by the bottom edge, or slides under the translucent bar, doesn't count: the buyer
 * can't use it there, so the buy bar stays (§1.1).
 */
function useWhollyInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // The bar's height includes the top safe area, which a CSS length in `rootMargin` can't express.
    const top = document.querySelector('[data-nav-bar]')?.getBoundingClientRect().height ?? 0;
    const observer = new IntersectionObserver(
      // 0.99, not 1: subpixel layout can leave a fully visible row a hair short of a ratio of exactly 1.
      ([entry]) => setInView((entry?.intersectionRatio ?? 1) >= 0.99),
      { rootMargin: `-${Math.round(top)}px 0px 0px 0px`, threshold: [0, 0.99, 1] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}
