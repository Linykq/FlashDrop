import { describe, expect, it } from 'vitest';
import {
  formatShipping,
  isSettling,
  orderStatusCopy,
  SLOW_PAYMENT_TEXT,
  statusAnnouncement,
} from './order-status';

const base = { closeReason: null, declineCode: null, paymentMethod: 'pm_ok', shipping: null } as const;

describe('orderStatusCopy', () => {
  it('shows a payment in progress with its steps and no action', () => {
    expect(orderStatusCopy({ ...base, status: 'PENDING_PAYMENT' })).toEqual({
      outcome: 'processing',
      tone: 'info',
      heading: 'Processing payment…',
      text: 'This usually takes a few seconds.',
      action: null,
      steps: 'payment',
    });
  });

  it('says when a payment takes longer than usual, and offers the order list instead of a wait', () => {
    expect(orderStatusCopy({ ...base, status: 'PENDING_PAYMENT' }, { slow: true })).toEqual({
      outcome: 'processing',
      tone: 'info',
      heading: 'Processing payment…',
      text: SLOW_PAYMENT_TEXT,
      action: { kind: 'orders', label: 'Your orders' },
      steps: 'payment',
    });
    expect(SLOW_PAYMENT_TEXT).toBe(
      'This is taking longer than usual. You can leave this page; your order keeps processing and appears in Your orders.',
    );
    // Once it settles, the outcome speaks for itself.
    expect(orderStatusCopy({ ...base, status: 'PAID' }, { slow: true }).action?.kind).toBe('drops');
  });

  it('celebrates a paid order and leads back to the drops', () => {
    expect(orderStatusCopy({ ...base, status: 'PAID' })).toMatchObject({
      tone: 'success',
      heading: 'You got it.',
      action: { kind: 'drops', label: 'Back to drops' },
      steps: 'paid',
    });
  });

  it('tells a declined card from a payment window that closed', () => {
    expect(
      orderStatusCopy({ ...base, status: 'PAYMENT_FAILED', declineCode: 'card_declined' }),
    ).toMatchObject({
      outcome: 'declined',
      tone: 'danger',
      heading: 'Payment declined',
      action: { kind: 'product', label: 'Back to the drop' },
      steps: null,
    });
    expect(
      orderStatusCopy({ ...base, status: 'PAYMENT_FAILED', declineCode: 'reference_closed' }),
    ).toMatchObject({
      outcome: 'payment-timeout',
      tone: 'neutral',
      heading: "Payment didn't finish in time",
      text: "We couldn't confirm your payment in time, so we released your reservation. Any charge is refunded.",
    });
  });

  it('tells an abandoned hold from a payment that never finished', () => {
    expect(orderStatusCopy({ ...base, status: 'EXPIRED', paymentMethod: null })).toMatchObject({
      outcome: 'expired',
      heading: 'Reservation expired',
      text: 'The hold ended before checkout was finished.',
      action: { kind: 'product', label: 'Back to the drop' },
    });
    expect(orderStatusCopy({ ...base, status: 'EXPIRED' }).outcome).toBe('payment-timeout');
  });

  it('explains a cancelled order and a refusal without blame', () => {
    expect(orderStatusCopy({ ...base, status: 'CANCELLED', paymentMethod: null })).toMatchObject({
      heading: 'Order cancelled',
      text: 'You left checkout, so we released your reservation.',
      action: { kind: 'product', label: 'Back to the drop' },
    });
    expect(orderStatusCopy({ ...base, status: 'REJECTED', closeReason: 'SOLD_OUT' })).toMatchObject({
      heading: 'Not reserved',
      text: 'Every unit was claimed before your reservation went through.',
    });
  });

  it('says that the charge of an order cancelled after checkout is refunded', () => {
    expect(orderStatusCopy({ ...base, status: 'CANCELLED' })).toMatchObject({
      outcome: 'cancelled',
      heading: 'Order cancelled',
      text: 'We released your reservation. Any charge is refunded.',
      action: { kind: 'product', label: 'Back to the drop' },
    });
  });
});

describe('isSettling', () => {
  it('keeps asking only while the payment runs', () => {
    expect(isSettling('PENDING_PAYMENT')).toBe(true);
    for (const status of ['PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED', 'REJECTED'] as const) {
      expect(isSettling(status)).toBe(false);
    }
  });
});

describe('statusAnnouncement', () => {
  it('reads the heading and its sentence as two sentences', () => {
    expect(statusAnnouncement(orderStatusCopy({ ...base, status: 'PAID' }))).toBe(
      'You got it. Your order is confirmed and paid.',
    );
    expect(statusAnnouncement(orderStatusCopy({ ...base, status: 'PAYMENT_FAILED' }))).toBe(
      'Payment declined. Your test card was declined, so we released your reservation.',
    );
  });
});

describe('formatShipping', () => {
  it('puts the address on one line, leaving out what is missing', () => {
    expect(
      formatShipping({
        name: 'Mira Chen',
        line1: '1 Main St',
        line2: 'Apt 4',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        country: 'US',
      }),
    ).toBe('Mira Chen, 1 Main St, Apt 4, Springfield, IL 62701');
    expect(
      formatShipping({ name: 'Ada', line1: '2 Elm St', city: 'Paris', postalCode: '75001', country: 'FR' }),
    ).toBe('Ada, 2 Elm St, Paris, 75001');
  });
});
