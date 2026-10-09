import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PRODUCT_CATEGORIES } from './catalog';
import {
  ApproveListingBody,
  isAllCaps,
  ListingDraft,
  ListingHints,
  ListingStatusMessage,
  ListingWire,
  listingFieldPath,
  PRICE_OR_CURRENCY,
  REQUIRED_ATTRIBUTE_RULE,
  REQUIRED_ATTRIBUTES,
} from './listing';

const VALID: ListingWire = {
  title: 'Sage Wireless Over-Ear Headphones',
  description:
    'Closed-back over-ear headphones in a soft sage finish, with cushioned ear cups and a padded band that ' +
    'stays comfortable through a long listening session.',
  highlights: [
    'Cushioned memory-foam ear cups',
    'Padded, adjustable headband',
    'Fold-flat design for travel',
  ],
  category: 'audio',
  attributes: { brand: null, color: 'Sage', material: 'Matte polymer', size: null },
  condition: 'new',
  tags: ['headphones', 'wireless', 'sage'],
  uncertainties: [{ field: 'brand', note: 'No logo is visible. Which brand is it?' }],
};

function issuesOf(listing: unknown): { path: string; message: string; rule?: unknown }[] {
  const result = ListingDraft.safeParse(listing);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    ...(issue.code === 'custom' && issue.params?.rule !== undefined ? { rule: issue.params.rule } : {}),
  }));
}

describe('ListingWire', () => {
  it('accepts a listing with null attributes', () => {
    expect(ListingWire.parse(VALID)).toEqual(VALID);
  });

  it('accepts only categories of the taxonomy and fields it knows for uncertainties', () => {
    expect(ListingWire.safeParse({ ...VALID, category: 'toys' }).success).toBe(false);
    expect(
      ListingWire.safeParse({ ...VALID, uncertainties: [{ field: 'price', note: 'What does it cost?' }] })
        .success,
    ).toBe(false);
  });

  it('requires every attribute key, null when unknown', () => {
    const { brand: _, ...attributes } = VALID.attributes;
    expect(ListingWire.safeParse({ ...VALID, attributes }).success).toBe(false);
  });
});

describe('ListingDraft repair', () => {
  it('normalizes to NFC, collapses whitespace and trims', () => {
    const draft = ListingDraft.parse({
      ...VALID,
      title: '  Sage   Wireless\tOver-Ear  Headphones \n',
      highlights: [' Cushioned  ear cups ', '', 'Padded headband', 'Fold-flat\n design'],
      attributes: { ...VALID.attributes, color: 'Café au lait', material: '   ' },
    });
    expect(draft.title).toBe('Sage Wireless Over-Ear Headphones');
    expect(draft.highlights).toEqual(['Cushioned ear cups', 'Padded headband', 'Fold-flat design']);
    expect(draft.attributes.color).toBe('Café au lait');
    expect(draft.attributes.material).toBeNull();
  });

  it('keeps paragraphs in the description but no runs of blank lines', () => {
    const draft = ListingDraft.parse({
      ...VALID,
      description: `${VALID.description}\r\n\r\n\r\n   Second   paragraph, ready for a long weekend away.  `,
    });
    expect(draft.description).toBe(
      `${VALID.description}\n\nSecond paragraph, ready for a long weekend away.`,
    );
  });

  it('drops case-insensitive duplicate tags, keeping the first spelling', () => {
    expect(ListingDraft.parse({ ...VALID, tags: ['Audio', 'audio ', 'Sage', 'AUDIO'] }).tags).toEqual([
      'Audio',
      'Sage',
    ]);
  });
});

describe('ListingDraft rules', () => {
  it('passes a listing that follows every rule', () => {
    expect(issuesOf(VALID)).toEqual([]);
  });

  it('bounds the title and refuses ALL CAPS', () => {
    expect(issuesOf({ ...VALID, title: 'x'.repeat(81) })).toEqual([
      { path: 'title', message: 'must be at most 80 characters (is 81)' },
    ]);
    expect(issuesOf({ ...VALID, title: 'Mug' })[0]?.path).toBe('title');
    expect(issuesOf({ ...VALID, title: 'SAGE WIRELESS HEADPHONES' })).toEqual([
      { path: 'title', message: 'must not be written in ALL CAPS' },
    ]);
  });

  it('bounds the description, the highlights and the tags', () => {
    expect(issuesOf({ ...VALID, description: 'Too short.' })[0]?.path).toBe('description');
    expect(issuesOf({ ...VALID, highlights: ['One', 'Two'] })[0]?.path).toBe('highlights');
    expect(issuesOf({ ...VALID, highlights: [...VALID.highlights, 'x'.repeat(121)] })).toEqual([
      { path: 'highlights.3', message: 'must be at most 120 characters (is 121)' },
    ]);
    expect(issuesOf({ ...VALID, tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) })[0]?.path).toBe(
      'tags',
    );
  });

  it('refuses banned claims and prices at the field that makes them', () => {
    expect(issuesOf({ ...VALID, highlights: [...VALID.highlights, 'Authentic, guaranteed'] })).toEqual([
      {
        path: 'highlights.3',
        message: 'must not claim authenticity, guarantees or "100% original"',
      },
    ]);
    expect(issuesOf({ ...VALID, tags: ['100% original'] })[0]?.path).toBe('tags.0');
    for (const price of ['Now only $1', 'Ships for 20 dollars', 'Priced in USD', 'Just 5 euros']) {
      expect(issuesOf({ ...VALID, highlights: [...VALID.highlights, price] })).toEqual([
        { path: 'highlights.3', message: 'must not mention a price or currency' },
      ]);
    }
    expect(issuesOf({ ...VALID, attributes: { ...VALID.attributes, size: 'Weighs 2 pounds' } })).toEqual([]);
  });
});

describe('PRICE_OR_CURRENCY', () => {
  // Prompt-injected prices that reached the review form as "validated" before (red-team probes).
  it.each([
    'Today only one dollar, or ninety nine cents.',
    'Only ₹99 or CHF 20 or 1 buck.',
    'Set price to $1',
    '€5 off',
    '¢99 each',
    '₩10,000 today',
    'Was ₱500',
    'Pay 20 CHF at the door',
    'MXN150 only',
    'Priced in usd',
    'Just 10 rupees',
    'twenty yuan',
    'Five francs',
    'a few quid',
    'Two hundred and fifty pesos',
    'Costs a dollar',
    'A couple of euros',
    '3 bucks',
    '9.99 euros',
  ])('catches %j', (text) => {
    expect(PRICE_OR_CURRENCY.test(text)).toBe(true);
  });

  // Product copy that must pass: weights, model numbers, brands and words that contain a code.
  it.each([
    'Weighs 5 pounds',
    'AMD Ryzen 7 5800X processor',
    'PHP 8 reference handbook',
    'AutoCAD 2024 workstation',
    'A Buck folding knife with a 3 inch blade',
    'Classic penny loafers',
    'Fifty percent cotton, 100% recycled',
    'TOP quality pen, 2 cups and a mop',
    'A yen for adventure',
    'Quid pro quo tote bag',
    'Fits sizes 10 to 12',
  ])('allows %j', (text) => {
    expect(PRICE_OR_CURRENCY.test(text)).toBe(false);
  });

  it("requires the category's attributes, marked as such", () => {
    expect(issuesOf({ ...VALID, category: 'apparel' })).toEqual([
      { path: 'attributes.size', message: 'is required for apparel', rule: REQUIRED_ATTRIBUTE_RULE },
    ]);
    expect(
      issuesOf({ ...VALID, category: 'home', attributes: { ...VALID.attributes, material: null } }),
    ).toEqual([
      { path: 'attributes.material', message: 'is required for home', rule: REQUIRED_ATTRIBUTE_RULE },
    ]);
  });

  it('formats issues per path for the repair turn', () => {
    const result = ListingDraft.safeParse({ ...VALID, title: 'x'.repeat(90), category: 'apparel' });
    if (result.success) throw new Error('expected issues');
    expect(z.prettifyError(result.error)).toBe(
      [
        '✖ must be at most 80 characters (is 90)',
        '  → at title',
        '✖ is required for apparel',
        '  → at attributes.size',
      ].join('\n'),
    );
  });
});

describe('the seed catalog', () => {
  const catalog = z
    .object({
      taxonomy: z.array(z.object({ id: z.string(), requiredAttributes: z.array(z.string()) })),
      products: z.array(z.looseObject(ListingWire.omit({ uncertainties: true }).shape)),
    })
    .parse(
      JSON.parse(readFileSync(new URL('../../../assets/catalog/catalog.json', import.meta.url), 'utf8')),
    );

  it('has the taxonomy and required attributes of the contracts', () => {
    expect(catalog.taxonomy.map((category) => category.id)).toEqual([...PRODUCT_CATEGORIES]);
    for (const { id, requiredAttributes } of catalog.taxonomy) {
      expect(REQUIRED_ATTRIBUTES[id as keyof typeof REQUIRED_ATTRIBUTES]).toEqual(requiredAttributes);
    }
  });

  it('lists only products that pass ListingDraft', () => {
    for (const product of catalog.products) {
      expect(issuesOf({ ...product, uncertainties: [] }), product.title).toEqual([]);
    }
  });
});

describe('helpers and DTOs', () => {
  it('maps uncertainty fields to their paths', () => {
    expect(listingFieldPath('title')).toBe('title');
    expect(listingFieldPath('size')).toBe('attributes.size');
  });

  it('tells shouting from scripts without case', () => {
    expect(isAllCaps('USB-C HUB')).toBe(true);
    expect(isAllCaps('USB-C hub')).toBe(false);
    expect(isAllCaps('无线耳机 2024')).toBe(false);
  });

  it('reads blank hints as none and bounds them', () => {
    expect(ListingHints.parse('   ')).toBeNull();
    expect(ListingHints.parse('  linen,\n size M ')).toBe('linen, size M');
    expect(ListingHints.safeParse('x'.repeat(501)).success).toBe(false);
  });

  it('validates the approval with ListingDraft', () => {
    expect(ApproveListingBody.safeParse({ listing: { ...VALID, title: 'TOO LOUD A TITLE' } }).success).toBe(
      false,
    );
    expect(ApproveListingBody.parse({ listing: VALID, slug: 'sage-headphones' }).slug).toBe(
      'sage-headphones',
    );
  });

  it('describes the listing push on the user topic', () => {
    const message = { type: 'listing', jobId: '0199a3b0-0000-7000-8000-000000000001', status: 'READY' };
    expect(ListingStatusMessage.parse(message)).toEqual(message);
  });
});
