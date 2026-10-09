/*
 * Every price, count, countdown and time the UI shows goes through this module (design-system §3.3), using
 * Intl only. The locale is fixed: the copy is English, and one locale keeps the server render and hydration
 * byte-identical. Time zones are the one thing that differs between server and client; see <LocalTime>.
 * Admin's own formats (`components/admin/format.ts`) build on the cached formatters here.
 */
export const LOCALE = 'en-US';

const numberFormatters = new Map<string, Intl.NumberFormat>();

/** One `Intl.NumberFormat` per set of options, made on first use: constructing one is costly. */
export function numberFormatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE, options);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

/** Deadlines closer than this show a running countdown; further ones show an absolute time (§3.3). */
export const COUNTDOWN_WINDOW_MS = 24 * 60 * 60 * 1000;

function moneyFormatter(currency: string, fractionDigits: 0 | 2): Intl.NumberFormat {
  return numberFormatter({
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
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

export function formatCount(count: number): string {
  return numberFormatter({}).format(count);
}

/** "3F2A9C1B": the first 8 hex characters of a UUID, uppercase, as people quote an order or a drop (§10.5). */
export function shortId(id: string): string {
  return id.replaceAll('-', '').slice(0, 8).toUpperCase();
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

/** Whole units in words: "2 minutes", "90 seconds". */
export function formatDuration(seconds: number): string {
  const minutes = seconds % 60 === 0;
  return numberFormatter({ style: 'unit', unit: minutes ? 'minute' : 'second', unitDisplay: 'long' }).format(
    minutes ? seconds / 60 : seconds,
  );
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

/** One `Intl.DateTimeFormat` per set of options, as `numberFormatter`. */
export function dateTimeFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let formatter = dateTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, options);
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * One spelling of a formatted time in every runtime. ICU versions space times differently: Node's puts a narrow
 * no-break space before "PM" and thin spaces around a range's dash, Chromium's plain spaces, and text rendered
 * on the server must equal what the browser renders while hydrating (`<LocalTime>`, admin times). So every
 * space becomes a plain one, the day period keeps its number with a no-break space, and a range within one day
 * closes up around its dash ("7:00–7:30 PM"), as across days it reads "11:00 PM – 1:00 AM".
 */
export function canonicalSpaces(text: string): string {
  return text
    .replace(/[\u00a0\u2009\u202f]/gu, ' ')
    .replace(/ (AM|PM)\b/g, '\u00a0$1')
    .replace(/(\d) \u2013 (\d)/g, '$1\u2013$2');
}

/** "7:00 PM", or "7:00 PM UTC" with `withZone`. */
export function formatTime(date: DateInput, { timeZone, withZone = false }: TimeZoneOptions = {}): string {
  return canonicalSpaces(
    dateTimeFormatter({
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: withZone ? 'short' : undefined,
    }).format(new Date(date)),
  );
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
