import { describe, expect, it } from 'vitest';
import {
  canonicalSpaces,
  formatAt,
  formatCount,
  formatCountdown,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatTime,
  plural,
  shortId,
} from './format';

describe('formatMoney', () => {
  it('drops a zero cents part on storefront surfaces', () => {
    expect(formatMoney(12_900, 'USD')).toBe('$129');
    expect(formatMoney(12_950, 'USD')).toBe('$129.50');
    expect(formatMoney(12_905, 'USD')).toBe('$129.05');
  });

  it('always shows cents in the exact style', () => {
    expect(formatMoney(25_800, 'USD', 'exact')).toBe('$258.00');
    expect(formatMoney(6_217_800, 'USD', 'exact')).toBe('$62,178.00');
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, '0:00'],
    [-5_000, '0:00'],
    [1, '0:01'],
    [9_000, '0:09'],
    [249_000, '4:09'],
    [249_001, '4:10'],
    [3_599_000, '59:59'],
    [3_600_000, '1:00:00'],
    [8_049_000, '2:14:09'],
  ])('%i ms reads %s', (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
  });
});

describe('shortId', () => {
  it('quotes the first 8 hex characters, uppercase', () => {
    expect(shortId('3f2a9c1b-4d5e-5f60-8a7b-9c0d1e2f3a4b')).toBe('3F2A9C1B');
  });
});

describe('counts, durations and plurals', () => {
  it('groups digits', () => {
    expect(formatCount(1284)).toBe('1,284');
  });

  it('spells whole units', () => {
    expect(formatDuration(120)).toBe('2 minutes');
    expect(formatDuration(60)).toBe('1 minute');
    expect(formatDuration(90)).toBe('90 seconds');
  });

  it('picks the plural form', () => {
    expect(plural(1, '1 in a cart', '1 in carts')).toBe('1 in a cart');
    expect(plural(3, '3 in a cart', '3 in carts')).toBe('3 in carts');
    expect(plural(0, '0 in a cart', '0 in carts')).toBe('0 in carts');
  });
});

describe('absolute times', () => {
  const start = '2026-10-06T23:00:00Z';

  it("spells times the same whatever spaces the runtime's ICU uses", () => {
    expect(canonicalSpaces('8:32\u202fAM\u2009–\u200912:00\u202fPM UTC')).toBe(
      '8:32\u00a0AM – 12:00\u00a0PM UTC',
    );
    expect(canonicalSpaces('8:32 AM – 12:00 PM UTC')).toBe('8:32\u00a0AM – 12:00\u00a0PM UTC');
    expect(canonicalSpaces('7:00\u2009–\u20097:30\u202fPM')).toBe('7:00–7:30\u00a0PM');
  });

  it('formats in the given zone', () => {
    expect(formatTime(start, { timeZone: 'America/Chicago' })).toBe('6:00\u00a0PM');
    expect(formatTime(start, { timeZone: 'UTC', withZone: true })).toBe('11:00\u00a0PM UTC');
    expect(formatDate(start, { timeZone: 'UTC' })).toBe('Tue, Oct 6');
  });

  it('says Today only when given now on the same calendar day in that zone', () => {
    expect(formatDateTime(start, { timeZone: 'UTC' })).toBe('Tue, Oct 6 at 11:00\u00a0PM');
    expect(formatDateTime(start, { timeZone: 'UTC', now: '2026-10-06T08:00:00Z' })).toBe(
      'Today at 11:00\u00a0PM',
    );
    // 23:00 UTC is already Oct 7 in Tokyo, while the morning of Oct 6 UTC is still Oct 6 there.
    expect(formatDateTime(start, { timeZone: 'Asia/Tokyo', now: '2026-10-06T08:00:00Z' })).toBe(
      'Wed, Oct 7 at 8:00\u00a0AM',
    );
  });

  it('says a deadline after its verb: the time today, otherwise the date and time', () => {
    expect(formatAt(start, { timeZone: 'UTC', now: '2026-10-06T08:00:00Z' })).toBe('at 11:00\u00a0PM');
    expect(formatAt(start, { timeZone: 'UTC', now: '2026-10-05T23:30:00Z' })).toBe(
      'Tue, Oct 6 at 11:00\u00a0PM',
    );
    expect(formatAt(start, { timeZone: 'UTC', withZone: true })).toBe('Tue, Oct 6 at 11:00\u00a0PM UTC');
  });
});
