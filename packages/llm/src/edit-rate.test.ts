import type { ListingWire } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import { listingEditRate } from './edit-rate';

const DRAFT: ListingWire = {
  title: 'Ribbed Ivory Stoneware Vase',
  description:
    'A tall stoneware vase in a warm ivory glaze, shaped with even horizontal rings that catch the light.',
  highlights: ['Even horizontal rings', 'Matte ivory glaze', 'Tapered neck'],
  category: 'home',
  attributes: { brand: null, color: 'Ivory', material: 'Stoneware', size: null },
  condition: 'new',
  tags: ['vase'],
  uncertainties: [{ field: 'size', note: 'How tall is it?' }],
};

describe('listingEditRate', () => {
  it('is 0 for an untouched draft, whatever happened to the uncertainties', () => {
    expect(listingEditRate(DRAFT, { ...DRAFT, uncertainties: [] })).toBe(0);
  });

  it('counts each changed field once, out of the ten listing fields', () => {
    const final = {
      ...DRAFT,
      title: 'Ribbed Stoneware Vase',
      attributes: { ...DRAFT.attributes, size: 'H 22 cm' },
      tags: ['vase', 'ceramic'],
    };
    expect(listingEditRate(DRAFT, final)).toBe(0.3);
  });

  it('is null when there was no draft to keep', () => {
    expect(listingEditRate(null, DRAFT)).toBeNull();
  });
});
