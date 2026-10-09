import { formatCount, type TimeZoneOptions } from '../../lib/format';

/*
 * Admin number and time formats (design-system §3.3) on top of `lib/format.ts`, with the same fixed locale:
 * compact tile values from 10,000, percentages, durations in short units, and drop windows. Pure functions, so
 * the server render (UTC) and the client (the viewer's zone) differ only in the zone they are given.
 */

const LOCALE = 'en-US';

/** Values from here up show compact in stat tiles ("12.9K", "$62.2K"), the exact value in the sub-line. */
export const COMPACT_FROM = 10_000;

const compactCount = new Intl.NumberFormat(LOCALE, {
  notation: 'compact',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** "1,284", or "12.9K" from 10,000. */
export function formatTileCount(count: number): string {
  return count >= COMPACT_FROM ? compactCount.format(count) : formatCount(count);
}

const tileMoneyFormatters = new Map<string, Intl.NumberFormat>();

function tileMoneyFormatter(currency: string, compact: boolean): Intl.NumberFormat {
  const key = `${currency}:${compact}`;
  let formatter = tileMoneyFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      ...(compact
        ? { notation: 'compact', minimumFractionDigits: 1, maximumFractionDigits: 1 }
        : { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
    });
    tileMoneyFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * A stat tile's money (§3.3, §9.23): "$62.2K" from $10,000, whole units below ("$1,300"). The exact amount,
 * with cents, always goes in the tile's sub-line: five tiles share a row, and a value with cents in
 * `text-title-1` is wider than a tile from $1,000 up, where the design's compact rule doesn't reach yet.
 */
export function formatTileMoney(cents: number, currency: string): string {
  return tileMoneyFormatter(currency, cents / 100 >= COMPACT_FROM).format(cents / 100);
}

const percentFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** "96.4%"; `null` when there is nothing to divide by. */
export function formatPercent(part: number, whole: number): string | null {
  return whole > 0 ? percentFormatter.format(part / whole) : null;
}

/** Short units for admin durations (§3.3): "45s", "4m 12s", "5m", "1h 05m", "2h". */
export function formatShortDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Seconds with one decimal below 10 ("0.4 s", "9.8 s"), whole above ("42 s"), then short units. */
export function formatLagSeconds(seconds: number): string {
  if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return formatShortDuration(seconds);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * One spelling of a formatted time in every runtime. ICU versions space dates differently: Node's puts a narrow
 * no-break space before "PM" and thin spaces around a range's dash, Chromium's plain spaces, and text rendered
 * on the server must equal what the browser renders while hydrating. So every space becomes a plain one, the
 * day period keeps its number with a no-break space, and a range within one day closes up around its dash
 * ("7:00–7:30 PM"), as across days it reads "11:00 PM – 1:00 AM".
 */
export function canonicalSpaces(text: string): string {
  return text
    .replace(/[\u00a0\u2009\u202f]/gu, ' ')
    .replace(/ (AM|PM)\b/g, '\u00a0$1')
    .replace(/(\d) \u2013 (\d)/g, '$1\u2013$2');
}

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(LOCALE, options);
    formatters.set(key, cached);
  }
  return cached;
}

/** "Oct 6, 7:00 PM": the short date of data tables (§9.22). */
export function formatShortDateTime(
  iso: string,
  { timeZone, withZone = false }: TimeZoneOptions = {},
): string {
  return canonicalSpaces(
    formatter({
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: withZone ? 'short' : undefined,
    }).format(new Date(iso)),
  );
}

/** "7:04:12 PM": when a live view was paused. */
export function formatClockTime(
  epochMs: number,
  { timeZone }: Pick<TimeZoneOptions, 'timeZone'> = {},
): string {
  return canonicalSpaces(
    formatter({ hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone }).format(epochMs),
  );
}

/**
 * A drop's window as one range (§10.8): "Oct 6, 7:00–7:30 PM" within a day, "Oct 6, 11:00 PM – Oct 7, 1:00 AM"
 * across days. `formatRange` drops whatever both ends share.
 */
export function formatWindow(
  startsAt: string,
  endsAt: string,
  { timeZone, withZone = false }: TimeZoneOptions = {},
): string {
  return canonicalSpaces(
    formatter({
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: withZone ? 'short' : undefined,
    }).formatRange(new Date(startsAt), new Date(endsAt)),
  );
}

const usdCost = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 3,
  maximumFractionDigits: 4,
});

/** A model call's cost, to a tenth of a cent: "$0.024" (SD §10 metrics). */
export function formatUsdCost(usd: number): string {
  return usdCost.format(usd);
}

/** A latency in seconds with one decimal: "9.8 s". */
export function formatLatency(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}
