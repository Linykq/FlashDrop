import { describe, expect, it } from 'vitest';
import { matchesFilter, parseDropFilter } from './drop-filter';

describe('drop filter', () => {
  it('reads ?status= and falls back to All for anything else', () => {
    expect(parseDropFilter('draft')).toBe('draft');
    expect(parseDropFilter('LIVE')).toBe('all');
    expect(parseDropFilter(['live'])).toBe('all');
    expect(parseDropFilter(undefined)).toBe('all');
  });

  it('counts a paused drop as live, and All as everything', () => {
    expect(matchesFilter('PAUSED', 'live')).toBe(true);
    expect(matchesFilter('LIVE', 'live')).toBe(true);
    expect(matchesFilter('SCHEDULED', 'live')).toBe(false);
    expect(matchesFilter('DRAFT', 'all')).toBe(true);
    expect(matchesFilter('ENDED', 'scheduled')).toBe(false);
  });
});
