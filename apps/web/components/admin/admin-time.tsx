'use client';

import { useSyncExternalStore } from 'react';
import { formatAt, formatDateTime, formatTime } from '../../lib/format';
import { formatShortDateTime, formatWindow } from './format';

/*
 * Admin times in the viewer's zone, hydration-safe like `<LocalTime>`: the server renders UTC with the zone's
 * name, hydration renders the same, then the client's own reading replaces it. Every format spells its spaces
 * one way (`canonicalSpaces` in `lib/format.ts`), because Node's and the browser's ICU space times differently
 * and hydration compares them character by character.
 */

const subscribeNever = () => () => {};
const UTC = { timeZone: 'UTC', withZone: true } as const;

function useZoned(server: () => string, client: () => string): string {
  return useSyncExternalStore(subscribeNever, client, server);
}

const SERVER_ZONE = { timeZone: 'UTC' } as const;
const VIEWER_ZONE = {} as const;

/**
 * The zone to format times in: the viewer's own in the browser, UTC in the server render and hydration, so
 * text derived from it (chart labels, tables) never mismatches.
 */
export function useViewerZone(): { timeZone?: string } {
  return useSyncExternalStore(
    subscribeNever,
    () => VIEWER_ZONE,
    () => SERVER_ZONE,
  );
}

/** "7:02 PM" in a zone from `useViewerZone`, spelled the same in every runtime. */
export function zonedTime(at: string | number, zone: { timeZone?: string }): string {
  return formatTime(at, zone);
}

/** A drop's window, "Oct 6, 7:00–7:30 PM" (design system §10.8). */
export function DropWindow({ startsAt, endsAt }: { startsAt: string; endsAt: string }) {
  const text = useZoned(
    () => formatWindow(startsAt, endsAt, UTC),
    () => formatWindow(startsAt, endsAt),
  );
  return <span className="tabular-nums">{text}</span>;
}

/** "Oct 6, 7:00 PM" (§9.22). */
export function ShortDateTime({ iso }: { iso: string }) {
  const text = useZoned(
    () => formatShortDateTime(iso, UTC),
    () => formatShortDateTime(iso),
  );
  return (
    <time dateTime={iso} className="tabular-nums">
      {text}
    </time>
  );
}

/**
 * `datetime`: "Today at 7:00 PM" or "Tue, Oct 6 at 7:00 PM"; `at`, after a verb: "at 7:00 PM" today,
 * otherwise "Tue, Oct 6 at 7:00 PM" (§3.3).
 */
export function AdminTime({ iso, format = 'datetime' }: { iso: string; format?: 'datetime' | 'at' }) {
  const text = useZoned(
    () => (format === 'at' ? formatAt(iso, UTC) : formatDateTime(iso, UTC)),
    () => (format === 'at' ? formatAt(iso, { now: Date.now() }) : formatDateTime(iso, { now: Date.now() })),
  );
  return <time dateTime={iso}>{text}</time>;
}
