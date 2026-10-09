import { describe, expect, it } from 'vitest';
import { scrolledAbove } from './hold-visibility';

describe('scrolledAbove', () => {
  const barBottom = 48;

  it('is out of view once the countdown has wholly passed under the bar', () => {
    expect(scrolledAbove({ isIntersecting: false, bottom: 40 }, barBottom)).toBe(true);
    expect(scrolledAbove({ isIntersecting: false, bottom: 48 }, barBottom)).toBe(true);
  });

  it('is in view while any of it shows, and when it lies below a viewport too short to reach it', () => {
    expect(scrolledAbove({ isIntersecting: true, bottom: 60 }, barBottom)).toBe(false);
    expect(scrolledAbove({ isIntersecting: false, bottom: 900 }, barBottom)).toBe(false);
  });
});
