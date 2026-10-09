'use client';

import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Hourglass,
  Info,
  type LucideIcon,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from 'react';
import { cx } from '../../lib/cx';
import { formatCount, formatDuration } from '../../lib/format';
import type { ViewerClaim } from '../../lib/hold';
import { buyAction, maxQuantity, type NextDrop, purchaseRow, UPCOMING_HREF } from '../../lib/purchase';
import { type ReserveNote, type ReserveNoteTone, reserveNote } from '../../lib/reserve-copy';
import { pendingQuantity } from '../../lib/reserve-key';
import { takeReturnFocus } from '../../lib/return-focus';
import { checkoutHref, ORDERS_HREF, orderPageHref } from '../../lib/routes';
import { describeStock, type StockState } from '../../lib/stock';
import { useFocusRescue } from '../../lib/use-focus-rescue';
import { useMediaQuery } from '../../lib/use-media-query';
import { useRefreshOnReturn } from '../../lib/use-refresh-on-return';
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
  serverNow: number;
  priceCents: number;
  currency: string;
  signedIn: boolean;
  /** This product page, to come back to after signing in. */
  returnTo: string;
  /** What the viewer already has of this drop when the page was rendered (§9.13). */
  claim: ViewerClaim;
  /** Where a sold-out drop sends the buyer: the next drop, or `null` for the list of upcoming ones. */
  next: NextDrop | null;
  /**
   * `page` on the product page: the terms below the row, and the sticky buy bar on phones. `card` in a drop
   * card (§9.12), which states the terms itself, with the bar below 1069 px, where the card sits under the
   * player rather than beside it and its Buy can start below the first viewport.
   */
  layout?: 'page' | 'card';
};

/**
 * The purchase row (§9.13, §10.2): the buyer's live hold if they have one, the quantity stepper and the Buy
 * button, the note a press can leave under them, the terms, and on narrow screens the sticky buy bar that
 * takes over while the row is not wholly on screen, so an available purchase action is always reachable
 * without scrolling (§1.1). With a live hold the filled action is always "Go to checkout": paying for the
 * hold is the next step while its clock runs, and reserving more is the gray one beside the stepper. A buyer
 * who has their limit is told so, a sold-out drop points to the next one, and a drop that hasn't opened shows
 * no button at all: its status line and countdown already say when (§1.4). When the control that had focus
 * leaves (a hold ends, a refusal replaces the row), focus stays in the panel (§13.2).
 */
export function PurchasePanel({
  dropId,
  stock,
  perUserLimit,
  holdSeconds,
  serverNow,
  priceCents,
  currency,
  signedIn,
  returnTo,
  claim,
  next,
  layout = 'page',
}: PurchasePanelProps) {
  const [endedHold, setEndedHold] = useState<string | null>(null);
  const shown = claim.held !== null && claim.held.id === endedHold ? { ...claim, held: null } : claim;
  const action = buyAction(stock, signedIn);
  const { state, buy, dismiss } = useReserve(dropId, returnTo, { prefetch: action.kind === 'buy' });
  const refusedAtLimit = state.problem?.kind === 'refused' && state.problem.code === 'LIMIT_REACHED';
  const row = purchaseRow(shown, perUserLimit, refusedAtLimit);
  const held = row.kind === 'checkout' ? row.held : null;
  // What the stepper may still offer: the limit less what the buyer holds and placed. With 1, no stepper (§9.6).
  const room = row.kind === 'have-limit' ? 0 : row.room;
  const max = maxQuantity(stock, Math.max(1, room));
  const [quantity, setQuantity] = useState(1);

  const panel = useRef<HTMLDivElement>(null);
  // The row comes and goes (a drop that opens grows one), so the observer follows the element itself.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [rowElement, setRowElement] = useState<HTMLDivElement | null>(null);
  const attachRow = useCallback((element: HTMLDivElement | null) => {
    rowRef.current = element;
    setRowElement(element);
  }, []);
  const bar = useRef<HTMLDivElement>(null);
  const inlineBuy = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const noteId = useId();
  const pressedIn = useRef<'row' | 'bar'>('row');
  const rowInView = useWhollyInView(rowElement);
  const narrow = useMediaQuery(layout === 'page' ? '(width < 735px)' : '(width < 1069px)');

  // After a reload, offer the unfinished request again: the same quantity reuses its key and replays it. A
  // request whose order the claim already holds is finished, though, and only lost its answer: its key goes,
  // so "Buy 1 more" beside that hold reserves more. A refreshed claim (back from checkout) checks again.
  useEffect(() => {
    const pending = pendingQuantity(dropId, claim.reserveKeys);
    if (pending !== null) setQuantity(pending);
  }, [dropId, claim.reserveKeys]);

  // The hold the buyer comes back from (Back, "Leave checkout", "Try again") is server data.
  useRefreshOnReturn();

  // The row's Buy, else its first control, else the row itself: never <body> (§13.2).
  const actionTarget = () =>
    inlineBuy.current ?? rowRef.current?.querySelector<HTMLElement>('a, button') ?? rowRef.current;
  useFocusRescue(panel, actionTarget);

  // Back from "Sign in to buy": the buyer came to buy, so focus starts where they left off.
  useEffect(() => {
    if (takeReturnFocus(returnTo)) actionTarget()?.focus();
  }, [returnTo]);

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
    // A refusal at the limit replaces the row, which then says it all (`HaveLimit`).
    (noteRef.current ?? rowRef.current)?.scrollIntoView({
      block: barShown ? 'center' : 'nearest',
      behavior: smoothScroll(),
    });
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

  const busy = state.phase !== 'idle';
  const toCheckout = (size: 'lg' | 'md', className?: string) =>
    held && (
      <ButtonLink href={checkoutHref(held.id)} size={size} className={className}>
        Go to checkout
      </ButtonLink>
    );
  const heldNotice = held && (
    <HeldOrderNotice
      order={held}
      serverNow={serverNow}
      onEnd={() => {
        setEndedHold(held.id);
        // Its row and "Go to checkout" leave with it, and nothing on screen says why without this.
        announce('Your reservation ended.');
      }}
      className={layout === 'page' ? 'mt-6' : undefined}
    />
  );

  // An ended drop has no Buy row, but a hold made before the end can still check out.
  if (action.kind === 'hidden') {
    return (
      held && (
        <div ref={panel}>
          {heldNotice}
          <div ref={attachRow} tabIndex={-1} className="mt-3 flex outline-none">
            {toCheckout('lg', 'flex-1')}
          </div>
        </div>
      )
    );
  }

  const soldOut = action.kind === 'closed' && action.reason === 'sold-out' && !busy;
  // The stepper sits only beside the button that reserves the chosen quantity (signed out, the choice would be
  // lost on the way through sign-in), and stays, locked, while its quantity is being reserved. Beside a hold it
  // goes with the gray "Buy 1 more".
  const choosing = row.kind !== 'have-limit' && ((action.kind === 'buy' && room > 0) || busy);
  const offersMore = row.kind === 'checkout' && choosing;
  const chosen = Math.min(quantity, max);
  // The bar keeps an available action within reach; a closed state has none, so it never pins a dead button.
  const actionable =
    row.kind === 'checkout' ||
    busy ||
    (row.kind === 'buy' && (action.kind === 'buy' || action.kind === 'sign-in'));
  const button = { action, reserve: state, quantity: chosen, maxQuantity: max, returnTo };
  const press = (from: 'row' | 'bar') => {
    pressedIn.current = from;
    buy(chosen);
  };
  const stepper = (size: 'md' | 'lg') =>
    choosing && (
      <QuantityStepper
        value={chosen}
        max={max}
        limit={Math.max(1, room)}
        size={size}
        disabled={busy}
        onChange={(value) => {
          setQuantity(value);
          dismiss();
        }}
      />
    );

  let main: ReactNode = null;
  if (row.kind === 'checkout') {
    main = toCheckout('lg', 'min-w-fit flex-1');
  } else if (row.kind === 'have-limit') {
    main = (
      <HaveLimit
        perUserLimit={perUserLimit}
        href={row.lastPlacedId === null ? ORDERS_HREF : orderPageHref(row.lastPlacedId)}
      />
    );
  } else if (soldOut) {
    main = (
      <ButtonLink href={next?.href ?? UPCOMING_HREF} variant="tinted" size="lg" className="min-w-fit flex-1">
        {next ? 'See the next drop' : 'See upcoming drops'}
      </ButtonLink>
    );
  } else if (!(action.kind === 'closed' && action.reason === 'opens') || busy) {
    main = (
      <>
        {stepper('lg')}
        <BuyButton
          {...button}
          onBuy={() => press('row')}
          buttonRef={inlineBuy}
          describedBy={state.problem ? noteId : undefined}
          className="min-w-fit flex-1"
        />
      </>
    );
  }

  return (
    <div ref={panel}>
      {heldNotice}
      {/* A label longer than the room beside the stepper wraps the button onto its own full-width line. */}
      {main !== null && (
        <div
          ref={attachRow}
          tabIndex={-1}
          className={cx(
            held ? 'mt-3' : layout === 'page' && 'mt-6',
            'flex flex-wrap items-center gap-3 outline-none',
          )}
        >
          {main}
        </div>
      )}
      {offersMore && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {stepper('md')}
          <BuyButton
            {...button}
            variant="gray"
            size="md"
            more
            onBuy={() => press('row')}
            buttonRef={inlineBuy}
            describedBy={state.problem ? noteId : undefined}
          />
        </div>
      )}
      {state.problem && row.kind !== 'have-limit' && (
        <ReserveNoteLine id={noteId} ref={noteRef} note={noteFor(state.problem)} />
      )}
      {soldOut && next && row.kind === 'buy' && (
        <p className="mt-3 text-footnote text-label-secondary">Up next: {next.title}</p>
      )}
      {action.kind === 'closed' && action.reason === 'all-reserved' && row.kind === 'buy' && (
        <p className="mt-3 text-footnote text-label-secondary">This page updates live if one frees up.</p>
      )}
      {/* One terms line under the row, so there is one rhythm below the button. A sold-out drop and a buyer
          who has their limit have no terms left to read. */}
      {layout === 'page' && row.kind !== 'have-limit' && !(soldOut && row.kind === 'buy') && (
        <p className="mt-3 text-footnote text-label-secondary">
          Limit {formatCount(perUserLimit)} per person. We hold your item for {formatDuration(holdSeconds)} at
          checkout.
        </p>
      )}
      {narrow && actionable && (
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
            {held ? toCheckout('md') : <BuyButton {...button} onBuy={() => press('bar')} size="md" />}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The buyer already has every unit the limit allows (§9.13): said plainly, with the way to the order, in place
 * of a Buy that api can only refuse.
 */
function HaveLimit({ perUserLimit, href }: { perUserLimit: number; href: string }) {
  const n = formatCount(perUserLimit);
  return (
    <div className="flex w-full flex-col gap-4">
      <p className="flex items-start gap-2 text-callout">
        <CircleCheck className="shrink-0 text-success" />
        <span>
          You have your {n}. Limit {n} per person.
        </span>
      </p>
      <ButtonLink href={href} variant="tinted" size="lg">
        View your order
      </ButtonLink>
    </div>
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
  ref: RefObject<HTMLParagraphElement | null>;
};

/**
 * Why the last press did not reserve (§9.13), under the button until the buyer acts again. Not a live
 * region: the panel announces it once, politely, through the Announcer. The inline Buy button points at it
 * with `aria-describedby`, so the reason is read with the control.
 */
function ReserveNoteLine({ id, note, ref }: ReserveNoteLineProps) {
  const Icon = glyphs[note.glyph];
  const tone = toneClass[note.tone];
  return (
    <p ref={ref} className={cx('mt-4 flex animate-fade-in items-start gap-1.5 text-callout', tone.text)}>
      {/* 16 px beside 20 px lines: 2 px down centres it on the first line. */}
      <Icon size={16} className={cx('mt-0.5 shrink-0', tone.icon)} />
      <span id={id}>{note.text}</span>
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
function useWhollyInView(element: HTMLElement | null): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
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
  }, [element]);
  return inView;
}
