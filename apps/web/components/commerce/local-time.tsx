'use client';

import { useSyncExternalStore } from 'react';
import { formatAt, formatDateTime, formatOpening, formatTime } from '../../lib/format';

type LocalTimeProps = {
  iso: string;
  /**
   * `datetime`: "Today at 7:00 PM" or "Tue, Oct 6 at 7:00 PM"; `time`: "7:00 PM"; `opening`, after "Opens":
   * "at 7:00 PM" today, otherwise "Tue, Oct 6"; `at`, after any verb: "at 7:00 PM" today, otherwise
   * "Tue, Oct 6 at 7:00 PM".
   */
  format?: 'datetime' | 'time' | 'opening' | 'at';
};

const subscribeNever = () => () => {};

function clientText(iso: string, format: NonNullable<LocalTimeProps['format']>): string {
  if (format === 'time') return formatTime(iso);
  if (format === 'opening') return formatOpening(iso, { now: Date.now() });
  if (format === 'at') return formatAt(iso, { now: Date.now() });
  return formatDateTime(iso, { now: Date.now() });
}

function serverText(iso: string, format: NonNullable<LocalTimeProps['format']>): string {
  const utc = { timeZone: 'UTC', withZone: true } as const;
  if (format === 'time') return formatTime(iso, utc);
  if (format === 'opening') return formatOpening(iso, utc);
  if (format === 'at') return formatAt(iso, utc);
  return formatDateTime(iso, utc);
}

/**
 * An absolute time in the viewer's time zone (§3.3). The server cannot know that zone, so it renders UTC with
 * the zone name, without "Today"; hydration renders the same, then the client's own reading replaces it, so
 * the markup never mismatches.
 */
export function LocalTime({ iso, format = 'datetime' }: LocalTimeProps) {
  const text = useSyncExternalStore(
    subscribeNever,
    () => clientText(iso, format),
    () => serverText(iso, format),
  );
  return <time dateTime={iso}>{text}</time>;
}
