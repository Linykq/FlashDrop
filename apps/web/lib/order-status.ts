import type { OrderDetail, OrderStatus, ShippingAddress } from '@flashdrop/contracts';
import { rejectionText } from './hold';

/*
 * What the order status page says for each order (design-system §10.5, §12.2): the glyph and its tone, the
 * heading and the sentence under it, the next step, and how far the steps got. Pure, so every case is tested
 * without a page. RESERVED never gets here: the page sends a held order to checkout.
 */

export type OrderOutcome =
  | 'processing'
  | 'paid'
  | 'declined'
  /** The payment window closed before the PSP confirmed: no card was declined, and any charge is refunded. */
  | 'payment-timeout'
  | 'expired'
  | 'cancelled'
  | 'rejected';

export type OutcomeTone = 'info' | 'success' | 'danger' | 'neutral';

export type OutcomeAction =
  | { kind: 'drops'; label: 'Back to drops' }
  /** A payment that takes longer than usual: the buyer may leave, and finds the order in the list. */
  | { kind: 'orders'; label: 'Your orders' }
  | { kind: 'product'; label: 'Back to the drop' };

export type OrderStatusCopy = {
  outcome: OrderOutcome;
  tone: OutcomeTone;
  heading: string;
  text: string;
  action: OutcomeAction | null;
  /** The step reached (§9.26): payment while it runs, paid once done; none for an order that ended unpaid. */
  steps: 'payment' | 'paid' | null;
};

type OrderFacts = Pick<OrderDetail, 'status' | 'closeReason' | 'declineCode' | 'paymentMethod' | 'shipping'>;

const PAYMENT_TIMEOUT = {
  heading: "Payment didn't finish in time",
  text: "We couldn't confirm your payment in time, so we released your reservation. Any charge is refunded.",
} as const;

/**
 * Whether checkout was submitted: such an order carries the details it was placed with, so a payment may have
 * run for it, and anything it charged is refunded when the order ends unpaid (SD §6.5).
 */
const wasSubmitted = (order: OrderFacts): boolean => Boolean(order.paymentMethod || order.shipping);

/**
 * How long a payment runs before the page stops saying it "usually takes a few seconds" and says it may take
 * longer: the PSP retries, or the consumers are down and the order waits for its payment window (SD §6.5).
 */
export const SLOW_PAYMENT_MS = 15_000;

/** What the page says from then on (§12.2), in place of "This usually takes a few seconds." */
export const SLOW_PAYMENT_TEXT =
  'This is taking longer than usual. You can leave this page; your order keeps processing and appears in Your orders.';

/** Which outcome an ended or paying order shows. */
export function orderOutcome(order: OrderFacts): OrderOutcome {
  switch (order.status) {
    // RESERVED never reaches the page (it sends a held order to checkout), and no order returns to it.
    case 'RESERVED':
    case 'PENDING_PAYMENT':
      return 'processing';
    case 'PAID':
      return 'paid';
    case 'PAYMENT_FAILED':
      // `reference_closed`: the payment consumer met a reference the expiry had already closed (SD §6.5).
      return order.declineCode === 'reference_closed' ? 'payment-timeout' : 'declined';
    case 'EXPIRED':
      // An expiry after checkout is a payment that never finished, not an abandoned hold.
      return wasSubmitted(order) ? 'payment-timeout' : 'expired';
    case 'CANCELLED':
      return 'cancelled';
    case 'REJECTED':
      return 'rejected';
  }
}

/**
 * `slow`: the page has shown the payment running for `SLOW_PAYMENT_MS`, so its sentence says so and offers
 * the order list instead of a wait with nothing to do.
 */
export function orderStatusCopy(
  order: OrderFacts,
  { slow = false }: { slow?: boolean } = {},
): OrderStatusCopy {
  const outcome = orderOutcome(order);
  // The drop may have sold out since: the way back says where it goes, not that buying again will work.
  const backToDrop = { kind: 'product', label: 'Back to the drop' } as const;
  switch (outcome) {
    case 'processing':
      return {
        outcome,
        tone: 'info',
        heading: 'Processing payment…',
        text: slow ? SLOW_PAYMENT_TEXT : 'This usually takes a few seconds.',
        action: slow ? { kind: 'orders', label: 'Your orders' } : null,
        steps: 'payment',
      };
    case 'paid':
      return {
        outcome,
        tone: 'success',
        heading: 'You got it.',
        text: 'Your order is confirmed and paid.',
        action: { kind: 'drops', label: 'Back to drops' },
        steps: 'paid',
      };
    case 'declined':
      return {
        outcome,
        tone: 'danger',
        heading: 'Payment declined',
        text: 'Your test card was declined, so we released your reservation.',
        action: backToDrop,
        steps: null,
      };
    case 'payment-timeout':
      return { outcome, tone: 'neutral', ...PAYMENT_TIMEOUT, action: backToDrop, steps: null };
    case 'expired':
      return {
        outcome,
        tone: 'neutral',
        heading: 'Reservation expired',
        text: 'The hold ended before checkout was finished.',
        action: backToDrop,
        steps: null,
      };
    case 'cancelled':
      return {
        outcome,
        tone: 'neutral',
        heading: 'Order cancelled',
        // Checkout's Leave cancels only a hold (`from=RESERVED`), but api still cancels an order being paid
        // for a client that asks without the precondition; its charge, if one was made, is refunded.
        text: wasSubmitted(order)
          ? 'We released your reservation. Any charge is refunded.'
          : 'You left checkout, so we released your reservation.',
        action: backToDrop,
        steps: null,
      };
    case 'rejected':
      return {
        outcome,
        tone: 'neutral',
        heading: 'Not reserved',
        text: rejectionText(order.closeReason),
        action: backToDrop,
        steps: null,
      };
  }
}

/**
 * What the Announcer reads when the status changes on screen: the heading and its sentence. A heading without
 * closing punctuation ("Payment declined") gets a full stop, so the two are read as two sentences.
 */
export function statusAnnouncement({ heading, text }: Pick<OrderStatusCopy, 'heading' | 'text'>): string {
  return `${/[.…]$/.test(heading) ? heading : `${heading}.`} ${text}`;
}

/** Whether the order may still change on its own, so the page keeps asking (SD §8.1: every 2 s). */
export function isSettling(status: OrderStatus): boolean {
  return status === 'PENDING_PAYMENT';
}

/** "Mira Chen, 1 Main St, Apt 4, Springfield, IL 62701": one line that wraps, as the details list shows it. */
export function formatShipping({ name, line1, line2, city, state, postalCode }: ShippingAddress): string {
  const region = [state, postalCode].filter(Boolean).join(' ');
  return [name, line1, line2, city, region].filter(Boolean).join(', ');
}
