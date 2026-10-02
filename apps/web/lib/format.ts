/*
 * Every price, count, countdown and time the UI shows goes through this module (design-system §3.3), using
 * Intl only. The locale is fixed: the copy is English, and one locale keeps the server render and hydration
 * byte-identical. Time zones are the one thing that differs between server and client; see <LocalTime>.
 */
const LOCALE = 'en-US';

/** Deadlines closer than this show a running countdown; further ones show an absolute time (§3.3). */
export const COUNTDOWN_WINDOW_MS = 24 * 60 * 60 * 1000;

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, fractionDigits: 0 | 2): Intl.NumberFormat {
  const key = `${currency}:${fractionDigits}`;
  let formatter = moneyFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    moneyFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * `storefront` drops a zero cents part ("$129", "$129.50") on tiles, product and live pages; `exact` always
 * shows cents ("$258.00") in checkout, orders and admin. Amounts are integer minor units of a two-decimal
 * currency, which is all the catalog uses.
 */
export type MoneyStyle = 'storefront' | 'exact';

export function formatMoney(cents: number, currency: string, style: MoneyStyle = 'storefront'): string {
  const fractionDigits = style === 'storefront' && cents % 100 === 0 ? 0 : 2;
  return moneyFormatter(currency, fractionDigits).format(cents / 100);
}

const countFormatter = new Intl.NumberFormat(LOCALE);

export function formatCount(count: number): string {
  return countFormatter.format(count);
}

/**
 * `h:mm:ss` from one hour up, `m:ss` below, never negative. Seconds round up, so "0:00" appears only once the
 * deadline has passed and the last whole second still reads "0:01".
 */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

const minuteFormatter = new Intl.NumberFormat(LOCALE, { style: 'unit', unit: 'minute', unitDisplay: 'long' });
const secondFormatter = new Intl.NumberFormat(LOCALE, { style: 'unit', unit: 'second', unitDisplay: 'long' });

/** Whole units in words: "2 minutes", "90 seconds". */
export function formatDuration(seconds: number): string {
  return seconds % 60 === 0 ? minuteFormatter.format(seconds / 60) : secondFormatter.format(seconds);
}

const pluralRules = new Intl.PluralRules(LOCALE);

/** Picks the singular or plural form: `plural(n, '1 in a cart', `${n} in carts`)`. */
export function plural(count: number, one: string, other: string): string {
  return pluralRules.select(count) === 'one' ? one : other;
}

export type TimeZoneOptions = {
  /** IANA zone; the runtime's own zone when omitted (the viewer's, in the browser). */
  timeZone?: string;
  /** Appends the zone name ("7:00 PM UTC"): the server render, which cannot know the viewer's zone. */
  withZone?: boolean;
};

type DateInput = string | number | Date;

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let formatter = dateTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, options);
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

/** "7:00 PM", or "7:00 PM UTC" with `withZone`. */
export function formatTime(date: DateInput, { timeZone, withZone = false }: TimeZoneOptions = {}): string {
  return dateTimeFormatter({
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: withZone ? 'short' : undefined,
  }).format(new Date(date));
}

/** "Tue, Oct 6". */
export function formatDate(date: DateInput, { timeZone }: Pick<TimeZoneOptions, 'timeZone'> = {}): string {
  return dateTimeFormatter({ weekday: 'short', month: 'short', day: 'numeric', timeZone }).format(
    new Date(date),
  );
}

function calendarDay(date: DateInput, timeZone: string | undefined): string {
  return dateTimeFormatter({ year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(
    new Date(date),
  );
}

/**
 * "Today at 7:00 PM" or "Tue, Oct 6 at 7:00 PM". "Today" needs `now`; without it the date is always spelled
 * out, which is what a render that must match on server and client uses.
 */
export function formatDateTime(
  date: DateInput,
  { timeZone, withZone = false, now }: TimeZoneOptions & { now?: DateInput } = {},
): string {
  const day =
    now !== undefined && calendarDay(date, timeZone) === calendarDay(now, timeZone)
      ? 'Today'
      : formatDate(date, { timeZone });
  return `${day} at ${formatTime(date, { timeZone, withZone })}`;
}

/**
 * A deadline after its verb, for a countdown's spoken equivalent ("Starts at 7:00 PM", §9.10): "at 7:00 PM" on
 * the same calendar day, otherwise "Sat, Oct 3 at 7:00 PM", so a deadline tomorrow is never read as today's.
 * Without `now` the date is always spelled out, as for `formatDateTime`.
 */
export function formatAt(
  date: DateInput,
  { timeZone, withZone = false, now }: TimeZoneOptions & { now?: DateInput } = {},
): string {
  const time = formatTime(date, { timeZone, withZone });
  return now !== undefined && calendarDay(date, timeZone) === calendarDay(now, timeZone)
    ? `at ${time}`
    : `${formatDate(date, { timeZone })} at ${time}`;
}

/**
 * When a drop opens, as the Buy button says it (§9.9): "at 7:00 PM" on the same calendar day, otherwise
 * "Tue, Oct 6". Without `now` the date is always spelled out, as for `formatDateTime`.
 */
export function formatOpening(
  date: DateInput,
  { timeZone, withZone = false, now }: TimeZoneOptions & { now?: DateInput } = {},
): string {
  return now !== undefined && calendarDay(date, timeZone) === calendarDay(now, timeZone)
    ? `at ${formatTime(date, { timeZone, withZone })}`
    : formatDate(date, { timeZone });
}
