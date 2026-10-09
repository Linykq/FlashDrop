import type { AdminDropListing, CreateDropBody } from '@flashdrop/contracts';

/*
 * The "New drop" / "Edit drop" sheet's values and checks (design system §10.8), as pure functions. Times are
 * typed in `datetime-local` fields, which know no zone: the browser reads them in the admin's own zone and
 * sends ISO instants, so the drop opens when the admin meant. The checks mirror `CreateDropBody`, which the
 * Server Action and api apply again; here they only word each problem for its field (§12.2).
 */

export type DropFormValues = {
  productId: string;
  /** Empty for a drop that sells without a live room. */
  roomId: string;
  startsAt: string;
  endsAt: string;
  /** As typed: "129", "129.50". */
  price: string;
  stock: string;
  perUserLimit: string;
  holdSeconds: string;
  paymentSeconds: string;
};

export type DropField = keyof DropFormValues;
export type DropFormErrors = Partial<Record<DropField, string>>;

/** What the sheet sends: `CreateDropBody`'s input, and every field of a PATCH. */
export type DropFormBody = Required<Pick<CreateDropBody, 'productId' | 'roomId' | 'startsAt' | 'endsAt'>> &
  Pick<CreateDropBody, 'priceCents' | 'stock' | 'perUserLimit' | 'holdSeconds' | 'paymentSeconds'>;

const HOUR_MS = 3_600_000;
const pad = (value: number) => String(value).padStart(2, '0');

/** An instant as a `datetime-local` value in the runtime's zone: "2026-10-06T19:00". */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` value as an ISO instant, read in the runtime's zone; `null` when it isn't one. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  // A date-time form without an offset is local time (ECMAScript Date.parse).
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** "129", "129.5", "1,299.00" in cents; `null` for anything else, zero included. */
export function parsePriceCents(text: string): number | null {
  const plain = text.trim().replaceAll(',', '');
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(plain);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

/** Cents as the price field shows them: "129" or "129.50". */
export function formatPriceInput(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/**
 * A new drop starts at the next whole hour after the coming one and runs an hour, so it is never already
 * open when the admin arms it a minute later.
 */
export function initialDropForm(
  source: AdminDropListing | { productId: string | null },
  now: number,
): DropFormValues {
  if ('id' in source) {
    return {
      productId: source.productId,
      roomId: source.roomId ?? '',
      startsAt: toLocalInput(source.startsAt),
      endsAt: toLocalInput(source.endsAt),
      price: formatPriceInput(source.priceCents),
      stock: String(source.inventory.total),
      perUserLimit: String(source.perUserLimit),
      holdSeconds: String(source.holdSeconds),
      paymentSeconds: String(source.paymentSeconds),
    };
  }
  const start = Math.ceil(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  return {
    productId: source.productId ?? '',
    roomId: '',
    startsAt: toLocalInput(new Date(start).toISOString()),
    endsAt: toLocalInput(new Date(start + HOUR_MS).toISOString()),
    price: '',
    stock: '',
    perUserLimit: '2',
    holdSeconds: '120',
    paymentSeconds: '300',
  };
}

function wholeNumber(text: string, min: number, max: number): number | null {
  const plain = text.trim().replaceAll(',', '');
  if (!/^\d+$/.test(plain)) return null;
  const value = Number(plain);
  return value >= min && value <= max ? value : null;
}

/** The sheet's values as a request body, or what to fix, field by field. */
export function validateDropForm(
  values: DropFormValues,
): { ok: true; body: DropFormBody } | { ok: false; errors: DropFormErrors } {
  const errors: DropFormErrors = {};
  const startsAt = fromLocalInput(values.startsAt);
  const endsAt = fromLocalInput(values.endsAt);
  const priceCents = parsePriceCents(values.price);
  const stock = wholeNumber(values.stock, 1, 100_000);
  const perUserLimit = wholeNumber(values.perUserLimit, 1, 10);
  const holdSeconds = wholeNumber(values.holdSeconds, 10, 900);
  const paymentSeconds = wholeNumber(values.paymentSeconds, 10, 1_800);

  if (values.productId === '') errors.productId = 'Choose a product.';
  if (startsAt === null) errors.startsAt = 'Enter when the drop starts.';
  if (endsAt === null) errors.endsAt = 'Enter when the drop ends.';
  else if (startsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
    errors.endsAt = 'End the drop after it starts.';
  }
  if (priceCents === null) errors.price = 'Enter a price, such as 129 or 129.50.';
  if (stock === null) errors.stock = 'Enter a whole number from 1 to 100,000.';
  if (perUserLimit === null) errors.perUserLimit = 'Choose a limit from 1 to 10.';
  if (holdSeconds === null) errors.holdSeconds = 'Enter 10 to 900 seconds.';
  if (paymentSeconds === null) errors.paymentSeconds = 'Enter 10 to 1,800 seconds.';

  if (
    startsAt === null ||
    endsAt === null ||
    priceCents === null ||
    stock === null ||
    perUserLimit === null ||
    holdSeconds === null ||
    paymentSeconds === null ||
    Object.keys(errors).length > 0
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    body: {
      productId: values.productId,
      roomId: values.roomId === '' ? null : values.roomId,
      startsAt,
      endsAt,
      priceCents,
      stock,
      perUserLimit,
      holdSeconds,
      paymentSeconds,
    },
  };
}

/** api's field paths (`priceCents`) as the sheet's fields (`price`). */
const SERVER_FIELDS: Readonly<Record<string, DropField>> = {
  productId: 'productId',
  roomId: 'roomId',
  startsAt: 'startsAt',
  endsAt: 'endsAt',
  priceCents: 'price',
  stock: 'stock',
  perUserLimit: 'perUserLimit',
  holdSeconds: 'holdSeconds',
  paymentSeconds: 'paymentSeconds',
};

/** Field problems api reported, on the sheet's fields; anything unmapped stays in the form's banner. */
export function serverFieldErrors(fields: Readonly<Record<string, string>> | undefined): DropFormErrors {
  const errors: DropFormErrors = {};
  for (const [path, message] of Object.entries(fields ?? {})) {
    const field = SERVER_FIELDS[path];
    // api's own issues read as predicates ("does not exist"); Zod's are sentences already.
    if (field) errors[field] = /^[a-z]/.test(message) ? `This ${message.replace(/\.$/, '')}.` : message;
  }
  return errors;
}
