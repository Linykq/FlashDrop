import {
  canonicalSpaces,
  dateTimeFormatter,
  formatCount,
  numberFormatter,
  type TimeZoneOptions,
} from '../../lib/format';

/*
 * Admin number and time formats (design-system §3.3) on top of `lib/format.ts`, with its locale, its cached
 * formatters and its one spelling of spaces in times (`canonicalSpaces`): compact tile values from 10,000,
 * percentages, durations in short units, and drop windows. Pure functions, so the server render (UTC) and the
 * client (the viewer's zone) differ only in the zone they are given.
 */

/** Values from here up show compact in stat tiles ("12.9K", "$62.2K"), the exact value in the sub-line. */
export const COMPACT_FROM = 10_000;

const COMPACT = { notation: 'compact', minimumFractionDigits: 1, maximumFractionDigits: 1 } as const;

/** "1,284", or "12.9K" from 10,000. */
export function formatTileCount(count: number): string {
  return count >= COMPACT_FROM ? numberFormatter(COMPACT).format(count) : formatCount(count);
}

function tileMoneyFormatter(currency: string, compact: boolean): Intl.NumberFormat {
  return numberFormatter({
    style: 'currency',
    currency,
    ...(compact ? COMPACT : { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
  });
}

/**
 * A stat tile's money (§3.3, §9.23): "$62.2K" from $10,000, whole units below ("$1,300"). The exact amount,
 * with cents, always goes in the tile's sub-line: five tiles share a row, and a value with cents in
 * `text-title-1` is wider than a tile from $1,000 up, where the design's compact rule doesn't reach yet.
 */
export function formatTileMoney(cents: number, currency: string): string {
  return tileMoneyFormatter(currency, cents / 100 >= COMPACT_FROM).format(cents / 100);
}

/** "96.4%"; `null` when there is nothing to divide by. */
export function formatPercent(part: number, whole: number): string | null {
  return whole > 0
    ? numberFormatter({ style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
        part / whole,
      )
    : null;
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

/** "Oct 6, 7:00 PM": the short date of data tables (§9.22). */
export function formatShortDateTime(
  iso: string,
  { timeZone, withZone = false }: TimeZoneOptions = {},
): string {
  return canonicalSpaces(
    dateTimeFormatter({
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
    dateTimeFormatter({ hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone }).format(epochMs),
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
    dateTimeFormatter({
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: withZone ? 'short' : undefined,
    }).formatRange(new Date(startsAt), new Date(endsAt)),
  );
}

/** A model call's cost, to a tenth of a cent: "$0.024" (SD §10 metrics). */
export function formatUsdCost(usd: number): string {
  return numberFormatter({
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 3,
    maximumFractionDigits: 4,
  }).format(usd);
}

/** A latency in seconds with one decimal: "9.8 s"; "<0.1 s" below that, never a "0.0 s" that reads as a bug. */
export function formatLatency(ms: number): string {
  if (ms < 100) return '<0.1 s';
  return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}
