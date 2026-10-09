import type { CheckoutBody } from '@flashdrop/contracts';
import { isPaymentMethod, type PaymentMethod } from '@flashdrop/domain';

/*
 * The checkout form's model (SD §8.3, design-system §10.4, §12.2): its fields in DOM order with their labels
 * and autocomplete tokens, the client-side checks that run before a submit, and the payment methods. Pure, so
 * the rules are tested without a browser. The store ships to the US, so the form asks more than api's
 * `ShippingAddress` requires (a state from the list, a 5-digit ZIP code) and caps lengths at api's limits; api
 * validates the body again (SD §5.1), and its field issues map back onto these fields, worded the same way.
 */

export const SHIPPING_FIELDS = ['name', 'line1', 'line2', 'city', 'state', 'postalCode', 'country'] as const;
export type ShippingField = (typeof SHIPPING_FIELDS)[number];

/** Every field the form can flag, in DOM order: the error summary lists them in this order. */
export const CHECKOUT_FIELDS = [...SHIPPING_FIELDS, 'paymentMethod'] as const;
export type CheckoutField = (typeof CHECKOUT_FIELDS)[number];

type FieldSpec = {
  label: string;
  /** `shipping …` tokens, so browsers fill the whole address in one go (WCAG 1.3.5). */
  autoComplete: string;
  maxLength?: number;
  /**
   * Exposed as `required`, so assistive technology says which fields are mandatory before a submit fails
   * (WCAG 3.3.2). The form is `noValidate`: the client checks below run instead of the browser's bubbles.
   */
  required: boolean;
  /** A format hint under the field (§9.4); never a placeholder. */
  helper?: string;
};

export const FIELD_SPECS: Readonly<Record<ShippingField, FieldSpec>> = {
  name: { label: 'Full name', autoComplete: 'shipping name', maxLength: 100, required: true },
  line1: { label: 'Address', autoComplete: 'shipping address-line1', maxLength: 200, required: true },
  line2: {
    label: 'Apartment, suite (optional)',
    autoComplete: 'shipping address-line2',
    maxLength: 200,
    required: false,
  },
  city: { label: 'City', autoComplete: 'shipping address-level2', maxLength: 100, required: true },
  state: { label: 'State', autoComplete: 'shipping address-level1', required: true },
  postalCode: {
    label: 'ZIP code',
    autoComplete: 'shipping postal-code',
    maxLength: 5,
    helper: '5 digits',
    required: true,
  },
  country: { label: 'Country', autoComplete: 'shipping country', required: true },
};

/** What each field says when it needs fixing (§12.2). Country is a one-option select and never fails. */
export const FIELD_ERRORS: Readonly<Record<Exclude<CheckoutField, 'line2'>, string>> = {
  name: 'Enter your full name.',
  line1: 'Enter your street address.',
  city: 'Enter your city.',
  state: 'Choose your state.',
  postalCode: 'Enter a 5-digit ZIP code.',
  country: 'Choose your country.',
  paymentMethod: 'Choose a payment method.',
};

/** The DOM id of a field's control, which the error summary links to. */
export function fieldId(field: CheckoutField): string {
  return field === 'paymentMethod' ? 'payment-pm_ok' : `shipping-${field}`;
}

/** The payment-mock's test methods (SD §6.5, `PAYMENT_METHODS`) by name, as checkout and the order page say it. */
const PAYMENT_METHOD_TITLES: Readonly<Record<PaymentMethod, string>> = {
  pm_ok: 'Card ending 4242',
  pm_decline: 'Declining card',
  pm_slow: 'Slow card',
  pm_flaky: 'Unreliable card',
};

/**
 * The test cards checkout offers (§10.4), in order: one that approves and one that declines, the two outcomes
 * a buyer can try, each honest about being a test and about what it does, so a buyer who picks the declining
 * card expects the decline. `pm_slow` and `pm_flaky` exercise the payment consumer's waits and retries from
 * the load tests and api; an order paid with one still shows its name.
 */
export const CHECKOUT_PAYMENT_METHODS: readonly {
  method: PaymentMethod;
  title: string;
  description: string;
}[] = [
  { method: 'pm_ok', title: PAYMENT_METHOD_TITLES.pm_ok, description: 'Test card that always approves.' },
  {
    method: 'pm_decline',
    title: PAYMENT_METHOD_TITLES.pm_decline,
    description: 'Test card that is always declined, so you can see what happens.',
  },
];

/** The label of a payment method an order carries. */
export function paymentMethodLabel(method: PaymentMethod): string {
  return PAYMENT_METHOD_TITLES[method];
}

export const COUNTRIES = [{ code: 'US', name: 'United States' }] as const;

/** The 50 states and DC, by USPS code. */
export const US_STATES: readonly (readonly [code: string, name: string])[] = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['DC', 'District of Columbia'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
];

const STATE_CODES = new Set(US_STATES.map(([code]) => code));

export type FieldErrors = Partial<Record<CheckoutField, string>>;

export type CheckoutValidation = { ok: true; body: CheckoutBody } | { ok: false; errors: FieldErrors };

/** Reads a form value as text; a file input or a missing field reads as empty. */
function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The client-side checks of §10.4, run on submit before anything is sent. Values are trimmed; the ZIP code
 * must be 5 digits; State and Country must be one of the options. Errors come back in DOM order. An empty
 * line 2 is left out of the body, as api would drop it, so it never shapes the checkout fingerprint.
 */
export function validateCheckout(form: FormData): CheckoutValidation {
  const values = {
    name: text(form, 'name'),
    line1: text(form, 'line1'),
    line2: text(form, 'line2'),
    city: text(form, 'city'),
    state: text(form, 'state'),
    postalCode: text(form, 'postalCode'),
    country: text(form, 'country'),
  };
  const paymentMethod = text(form, 'paymentMethod');

  const country = COUNTRIES.find(({ code }) => code === values.country)?.code;

  const errors: FieldErrors = {};
  if (values.name === '') errors.name = FIELD_ERRORS.name;
  if (values.line1 === '') errors.line1 = FIELD_ERRORS.line1;
  if (values.city === '') errors.city = FIELD_ERRORS.city;
  if (!STATE_CODES.has(values.state)) errors.state = FIELD_ERRORS.state;
  if (!/^\d{5}$/.test(values.postalCode)) errors.postalCode = FIELD_ERRORS.postalCode;
  if (country === undefined) errors.country = FIELD_ERRORS.country;
  if (!isPaymentMethod(paymentMethod)) errors.paymentMethod = FIELD_ERRORS.paymentMethod;

  // The last two checks repeat the ones above, for the compiler's narrowing.
  if (Object.keys(errors).length > 0 || country === undefined || !isPaymentMethod(paymentMethod)) {
    return { ok: false, errors };
  }
  const { line2, ...required } = values;
  return {
    ok: true,
    body: { shipping: { ...required, ...(line2 ? { line2 } : {}), country }, paymentMethod },
  };
}

/** The fields with an error, in DOM order. */
export function erroredFields(errors: FieldErrors): CheckoutField[] {
  return CHECKOUT_FIELDS.filter((field) => errors[field] !== undefined);
}

/**
 * api's field issues (`ProblemDetails.errors`, dotted paths relative to the body such as
 * `shipping.postalCode`) as this form's errors, worded like the client's own checks: api's messages are for
 * developers. Issues on paths the form has no message for are dropped (line 2 is optional and capped by its
 * `maxLength`); if none is left, `null`, and the caller treats the answer as a failed submit.
 */
export function fieldErrorsFromIssues(issues: readonly { path: string }[]): FieldErrors | null {
  const errors: FieldErrors = {};
  for (const { path } of issues) {
    const field = path.startsWith('shipping.') ? path.slice('shipping.'.length) : path;
    if (field in FIELD_ERRORS) {
      const known = field as keyof typeof FIELD_ERRORS;
      errors[known] = FIELD_ERRORS[known];
    }
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/** "Fix 1 field to continue" or "Fix 2 fields to continue" (§12.2). */
export function errorSummaryTitle(count: number): string {
  return `Fix ${count} ${count === 1 ? 'field' : 'fields'} to continue`;
}
