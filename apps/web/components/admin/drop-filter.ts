import type { DropStatus } from '@flashdrop/contracts';

/*
 * The drop list's filter (design system §10.8): All, Live, Scheduled, Draft, Ended. Live covers PAUSED too:
 * a paused drop is a live one on hold, and it is the one an admin is looking for.
 */

export const DROP_FILTERS = ['all', 'live', 'scheduled', 'draft', 'ended'] as const;
export type DropFilter = (typeof DROP_FILTERS)[number];

export const DROP_FILTER_LABELS: Readonly<Record<DropFilter, string>> = {
  all: 'All',
  live: 'Live',
  scheduled: 'Scheduled',
  draft: 'Draft',
  ended: 'Ended',
};

const STATUSES: Readonly<Record<Exclude<DropFilter, 'all'>, readonly DropStatus[]>> = {
  live: ['LIVE', 'PAUSED'],
  scheduled: ['SCHEDULED'],
  draft: ['DRAFT'],
  ended: ['ENDED'],
};

export function matchesFilter(status: DropStatus, filter: DropFilter): boolean {
  return filter === 'all' || STATUSES[filter].includes(status);
}

/** `?status=` as a filter; anything else is All. */
export function parseDropFilter(value: unknown): DropFilter {
  return typeof value === 'string' && (DROP_FILTERS as readonly string[]).includes(value)
    ? (value as DropFilter)
    : 'all';
}

/** What a filter with nothing in it says (§12.2), and whether it offers "Show all". */
export const EMPTY_FILTER_COPY: Readonly<
  Record<Exclude<DropFilter, 'all'>, { title: string; description: string }>
> = {
  live: { title: 'No live drops', description: "Drops show up here while they're live." },
  scheduled: { title: 'No scheduled drops', description: 'Armed drops show up here until they open.' },
  draft: { title: 'No drafts', description: 'Drafts show up here until you arm them.' },
  ended: { title: 'No ended drops', description: 'Drops show up here once they end.' },
};
