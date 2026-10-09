import { CreateDropBody } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import {
  type DropFormValues,
  formatPriceInput,
  fromLocalInput,
  initialDropForm,
  parsePriceCents,
  serverFieldErrors,
  toLocalInput,
  validateDropForm,
} from './drop-form';

const PRODUCT = '5eed0003-0000-4000-8000-000000000002';

const VALID: DropFormValues = {
  productId: PRODUCT,
  roomId: '',
  startsAt: '2026-10-06T19:00',
  endsAt: '2026-10-06T19:30',
  price: '129.50',
  stock: '500',
  perUserLimit: '2',
  holdSeconds: '120',
  paymentSeconds: '300',
};

describe('drop form', () => {
  it('reads prices as cents, refusing zero, fractions of a cent and junk', () => {
    expect(parsePriceCents('129')).toBe(12_900);
    expect(parsePriceCents(' 129.5 ')).toBe(12_950);
    expect(parsePriceCents('1,299.00')).toBe(129_900);
    expect(parsePriceCents('0')).toBeNull();
    expect(parsePriceCents('0.001')).toBeNull();
    expect(parsePriceCents('$129')).toBeNull();
    expect(parsePriceCents('')).toBeNull();
    expect(formatPriceInput(12_900)).toBe('129');
    expect(formatPriceInput(12_950)).toBe('129.50');
  });

  it('round-trips datetime-local values through ISO instants in the local zone', () => {
    const iso = fromLocalInput('2026-10-06T19:00');
    expect(iso).not.toBeNull();
    expect(toLocalInput(iso ?? '')).toBe('2026-10-06T19:00');
    expect(fromLocalInput('tomorrow')).toBeNull();
    expect(fromLocalInput('')).toBeNull();
  });

  it('builds a body the contract accepts', () => {
    const result = validateDropForm(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({ productId: PRODUCT, roomId: null, priceCents: 12_950, stock: 500 });
    expect(CreateDropBody.safeParse(result.body).success).toBe(true);
  });

  it('words every problem for its field', () => {
    const result = validateDropForm({
      ...VALID,
      productId: '',
      endsAt: '2026-10-06T18:00',
      price: '0',
      stock: '100001',
      holdSeconds: '5',
      paymentSeconds: '2000',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        productId: 'Choose a product.',
        endsAt: 'End the drop after it starts.',
        price: 'Enter a price, such as 129 or 129.50.',
        stock: 'Enter a whole number from 1 to 100,000.',
        holdSeconds: 'Enter 10 to 900 seconds.',
        paymentSeconds: 'Enter 10 to 1,800 seconds.',
      },
    });
  });

  it('starts a new drop at a whole hour, at least an hour out, for one hour', () => {
    const now = Date.parse('2026-10-06T18:20:00.000Z');
    const values = initialDropForm({ productId: null }, now);
    const start = Date.parse(fromLocalInput(values.startsAt) ?? '');
    const end = Date.parse(fromLocalInput(values.endsAt) ?? '');
    expect(start - now).toBeGreaterThanOrEqual(3_600_000);
    expect(new Date(start).getUTCMinutes()).toBe(0);
    expect(end - start).toBe(3_600_000);
    expect(values).toMatchObject({
      productId: '',
      perUserLimit: '2',
      holdSeconds: '120',
      paymentSeconds: '300',
    });
  });

  it('puts api field problems on the sheet fields', () => {
    expect(serverFieldErrors({ productId: 'does not exist', priceCents: 'Too big', other: 'x' })).toEqual({
      productId: 'This does not exist.',
      price: 'Too big',
    });
  });
});
