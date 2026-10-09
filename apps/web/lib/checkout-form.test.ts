import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_FIELDS,
  CHECKOUT_PAYMENT_METHODS,
  erroredFields,
  errorSummaryTitle,
  FIELD_SPECS,
  fieldErrorsFromIssues,
  paymentMethodLabel,
  validateCheckout,
} from './checkout-form';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

const complete = {
  name: ' Mira Chen ',
  line1: '1 Main St',
  line2: '',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
  country: 'US',
  paymentMethod: 'pm_ok',
};

describe('validateCheckout', () => {
  it('builds the body from trimmed values, leaving out an empty line 2', () => {
    expect(validateCheckout(form(complete))).toEqual({
      ok: true,
      body: {
        shipping: {
          name: 'Mira Chen',
          line1: '1 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        },
        paymentMethod: 'pm_ok',
      },
    });
    const withLine2 = validateCheckout(form({ ...complete, line2: 'Apt 4' }));
    expect(withLine2.ok && withLine2.body.shipping.line2).toBe('Apt 4');
  });

  it('flags every missing or malformed field with its own words, in DOM order', () => {
    const result = validateCheckout(form({ country: 'US', postalCode: '1234', state: 'ZZ', name: '   ' }));
    expect(result).toEqual({
      ok: false,
      errors: {
        name: 'Enter your full name.',
        line1: 'Enter your street address.',
        city: 'Enter your city.',
        state: 'Choose your state.',
        postalCode: 'Enter a 5-digit ZIP code.',
        paymentMethod: 'Choose a payment method.',
      },
    });
    expect(result.ok ? [] : erroredFields(result.errors)).toEqual([
      'name',
      'line1',
      'city',
      'state',
      'postalCode',
      'paymentMethod',
    ]);
  });

  it('accepts only 5-digit ZIP codes and known payment methods', () => {
    for (const postalCode of ['6270', '627011', '62701-1234', 'abcde']) {
      expect(validateCheckout(form({ ...complete, postalCode })).ok).toBe(false);
    }
    expect(validateCheckout(form({ ...complete, paymentMethod: 'pm_unknown' })).ok).toBe(false);
  });
});

describe('fieldErrorsFromIssues', () => {
  it("words api's field issues like the form's own checks", () => {
    expect(
      fieldErrorsFromIssues([
        { path: 'shipping.postalCode' },
        { path: 'paymentMethod' },
        { path: 'shipping.name' },
      ]),
    ).toEqual({
      postalCode: 'Enter a 5-digit ZIP code.',
      paymentMethod: 'Choose a payment method.',
      name: 'Enter your full name.',
    });
  });

  it('gives up on issues the form has no field for', () => {
    expect(fieldErrorsFromIssues([{ path: '' }, { path: 'shipping.line2' }])).toBeNull();
  });
});

describe('copy', () => {
  it('counts the fields to fix', () => {
    expect(errorSummaryTitle(1)).toBe('Fix 1 field to continue');
    expect(errorSummaryTitle(2)).toBe('Fix 2 fields to continue');
  });

  it('names payment methods, including those only api and the load tests use', () => {
    expect(paymentMethodLabel('pm_ok')).toBe('Card ending 4242');
    expect(paymentMethodLabel('pm_slow')).toBe('Slow card');
  });

  it('offers the approving and the declining test card, approving first', () => {
    expect(CHECKOUT_PAYMENT_METHODS.map(({ method }) => method)).toEqual(['pm_ok', 'pm_decline']);
    for (const { method, title } of CHECKOUT_PAYMENT_METHODS) expect(title).toBe(paymentMethodLabel(method));
  });

  it('marks every field but line 2 required, so assistive technology says so before a submit', () => {
    const required = Object.entries(FIELD_SPECS).filter(([, spec]) => spec.required);
    expect(required.map(([field]) => field)).toEqual([
      'name',
      'line1',
      'city',
      'state',
      'postalCode',
      'country',
    ]);
  });

  it('gives every shipping field a shipping autocomplete token', () => {
    for (const spec of Object.values(FIELD_SPECS)) expect(spec.autoComplete).toMatch(/^shipping /);
    expect(CHECKOUT_FIELDS.at(-1)).toBe('paymentMethod');
  });
});
