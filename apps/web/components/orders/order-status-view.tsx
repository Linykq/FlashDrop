'use client';

import type { OrderDetail, OrderStatus } from '@flashdrop/contracts';
import {
  Ban,
  CircleCheck,
  CircleMinus,
  CircleX,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { focusOnLoad } from '../../lib/focus';
import {
  isSettling,
  type OrderOutcome,
  type OutcomeTone,
  orderStatusCopy,
  SLOW_PAYMENT_MS,
  SLOW_PAYMENT_TEXT,
  statusAnnouncement,
} from '../../lib/order-status';
import { useUserEvents } from '../../lib/realtime/hooks';
import { loginHref, ORDERS_HREF, orderPageHref } from '../../lib/routes';
import { orderRequests, usePrefetchOrderRequests } from '../../lib/use-order-requests';
import { useRefreshOnReturn } from '../../lib/use-refresh-on-return';
import { announce } from '../ui/announcer';
import { ButtonLink } from '../ui/button';
import { type StepState, Steps } from '../ui/steps';
import { OrderDetails } from './order-details';

/** SD §8.1: a 2 s poll while the payment runs. */
const POLL_MS = 2_000;

const toneClass: Record<OutcomeTone, string> = {
  info: 'bg-accent-tint text-accent-label',
  success: 'bg-success-tint text-success',
  danger: 'bg-danger-tint text-danger',
  neutral: 'bg-fill-tertiary text-label-secondary',
};

const outcomeIcon: Record<Exclude<OrderOutcome, 'processing' | 'paid'>, LucideIcon> = {
  declined: CircleX,
  'payment-timeout': Hourglass,
  expired: Hourglass,
  cancelled: Ban,
  rejected: CircleMinus,
};

type OrderStatusViewProps = {
  /** The order as the server rendered it. */
  order: OrderDetail;
  /** The product page, where "Back to the drop" leads. */
  productHref: string;
};

/**
 * The order's live status (design-system §10.5): the glyph, the heading and its sentence, the steps while the
 * payment can still finish, the details, and the next step. While the payment runs, the buyer's `user` topic
 * pushes the order's new status the moment it changes, and the page also reads the status every 2 s (SD
 * §8.1), the fallback for an event missed while the socket reconnects. Either way, a changed status asks the
 * server for the page again, so what is shown is always the server's contract-checked render; the heading and
 * text change in place, the glyph fades over, and the Announcer reads the new heading politely. Focus starts
 * on the heading, unless the buyer got somewhere first, and never moves for an update. A payment still running
 * after 15 s says it is taking longer than usual and offers the order list, announced once: the order keeps
 * processing without the page.
 */
export function OrderStatusView({ order, productHref }: OrderStatusViewProps) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const settling = isSettling(order.status);
  const [slow, setSlow] = useState(false);
  const copy = orderStatusCopy(order, { slow });

  usePrefetchOrderRequests();
  useRefreshOnReturn();

  // The status a refresh was asked for, by the poll or the socket, so a slow refresh isn't asked for twice.
  const refreshedFor = useRef<OrderStatus | null>(null);
  const refreshFor = (status: OrderStatus) => {
    if (status === order.status || status === refreshedFor.current) return;
    refreshedFor.current = status;
    router.refresh();
  };

  useUserEvents((event) => {
    if (event.type === 'order' && event.orderId === order.id) refreshFor(event.status);
  }, settling);

  useEffect(() => focusOnLoad(heading.current), []);

  // Counted from when the page first showed the payment running; a page shown again keeps what it said. The
  // sentence changes in place, so it is announced, once, when it does.
  useEffect(() => {
    if (!settling || slow) return;
    const timer = setTimeout(() => {
      setSlow(true);
      announce(SLOW_PAYMENT_TEXT);
    }, SLOW_PAYMENT_MS);
    return () => clearTimeout(timer);
  }, [settling, slow]);

  // A change after load is announced politely; the page as loaded is read in order.
  const announced = useRef(copy.heading);
  useEffect(() => {
    if (announced.current === copy.heading) return;
    announced.current = copy.heading;
    announce(statusAnnouncement(copy));
  }, [copy.heading, copy.text]);

  const onPolled = useEffectEvent((status: OrderStatus) => refreshFor(status));
  useEffect(() => {
    if (!settling) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      const requests = await orderRequests();
      const read = requests ? await requests.readOrder(order.id, controller.signal) : null;
      if (read?.kind === 'ok') onPolled(read.order.status);
      else if (read?.kind === 'signed-out') router.push(loginHref(orderPageHref(order.id)));
      // A miss (offline, api restarting) just waits for the next round; not-found can't recover, so it stops.
      if (read?.kind === 'ok' || read?.kind === 'failed' || read === null) schedule();
    }
    function schedule(): void {
      clearTimeout(timer);
      // A hidden tab stops asking and asks at once when it is shown again.
      if (!document.hidden) timer = setTimeout(() => void poll().catch(ignoreAbort), POLL_MS);
    }
    function ignoreAbort(error: unknown): void {
      if (!controller.signal.aborted) throw error;
    }
    function onVisibilityChange(): void {
      if (!document.hidden) void poll().catch(ignoreAbort);
    }

    schedule();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [settling, order.id, router]);

  return (
    <>
      <div className="flex flex-col items-center text-center">
        <span
          className={cx(
            'grid size-18 place-items-center rounded-full transition-colors duration-200 ease-standard',
            toneClass[copy.tone],
          )}
        >
          <OutcomeGlyph key={copy.outcome} outcome={copy.outcome} />
        </span>
        <h1 ref={heading} tabIndex={-1} className="mt-5 text-display-2 outline-none">
          {copy.heading}
        </h1>
        <p className="mt-3 max-w-text text-body text-label-secondary">{copy.text}</p>
      </div>
      {copy.steps && (
        <div className="mt-8 flex justify-center sm:block">
          <Steps label="Order progress" steps={progress(copy.steps)} />
        </div>
      )}
      <div className="mt-8">
        <OrderDetails order={order} />
      </div>
      {copy.action && (
        <div className="mt-8 flex justify-center">
          {copy.action.kind === 'drops' || copy.action.kind === 'orders' ? (
            <ButtonLink href={copy.action.kind === 'drops' ? '/' : ORDERS_HREF} variant="plain">
              {copy.action.label}
            </ButtonLink>
          ) : (
            <ButtonLink href={productHref} size="lg">
              {copy.action.label}
            </ButtonLink>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The status glyph, keyed by outcome so a change fades the new one in over the circle's colour change (§6.4).
 * The PAID check pops in on the `celebrate` curve; with reduced motion it only fades.
 */
function OutcomeGlyph({ outcome }: { outcome: OrderOutcome }) {
  if (outcome === 'processing') return <LoaderCircle size={40} strokeWidth={1.5} className="animate-spin" />;
  if (outcome === 'paid') {
    return (
      <CircleCheck
        size={40}
        strokeWidth={1.5}
        className="motion-safe:animate-celebrate motion-reduce:animate-fade-in"
      />
    );
  }
  const Icon = outcomeIcon[outcome];
  return <Icon size={40} strokeWidth={1.5} className="animate-fade-in" />;
}

function progress(reached: 'payment' | 'paid'): { label: string; state: StepState }[] {
  return [
    { label: 'Reserved', state: 'done' },
    // The glyph above already spins while the payment runs: one moving thing, so the step only marks the place.
    { label: 'Payment', state: reached === 'payment' ? 'current' : 'done' },
    { label: 'Paid', state: reached === 'paid' ? 'done' : 'upcoming' },
  ];
}
