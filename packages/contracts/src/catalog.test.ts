import { describe, expect, it } from 'vitest';
import {
  DropListQuery,
  DropSummary,
  PhotoCredit,
  ProductAttributes,
  ProductDetail,
  StockSnapshot,
} from './catalog';
import { ImageKey, uploadPath } from './common';
import { ProblemDetails } from './problem';

const KEY = `${'a'.repeat(64)}.jpg`;

const drop = {
  id: '5eed0004-0000-4000-8000-000000000001',
  status: 'LIVE',
  startsAt: '2026-10-02T10:00:00.000Z',
  endsAt: '2026-10-02T13:00:00.000Z',
  priceCents: 14900,
  currency: 'USD',
  perUserLimit: 2,
  holdSeconds: 120,
  room: { slug: 'studio', title: 'FlashDrop Studio' },
} as const;

const product = {
  id: '5eed0003-0000-4000-8000-000000000002',
  slug: 'sage-wireless-headphones',
  title: 'Sage Wireless Over-Ear Headphones',
  imageKeys: [KEY],
};

describe('DropListQuery', () => {
  it('defaults to live and scheduled drops', () => {
    expect(DropListQuery.parse({})).toEqual({ status: ['LIVE', 'SCHEDULED'], limit: 20 });
  });

  it('parses a comma-separated, case-insensitive status list and a numeric limit', () => {
    expect(DropListQuery.parse({ status: 'live, Ended,live', limit: '5' })).toEqual({
      status: ['LIVE', 'ENDED'],
      limit: 5,
    });
  });

  it.each([{ status: 'draft' }, { status: '' }, { status: 'live,,ended' }, { limit: '0' }, { limit: '51' }])(
    'rejects %j',
    (query) => {
      expect(DropListQuery.safeParse(query).success).toBe(false);
    },
  );
});

describe('ProductAttributes', () => {
  it("parses the column default '{}' to a complete object", () => {
    expect(ProductAttributes.parse({})).toEqual({
      category: null,
      condition: null,
      brand: null,
      color: null,
      material: null,
      size: null,
      highlights: [],
      tags: [],
      photoCredits: [],
    });
  });

  it('rejects a category outside the taxonomy', () => {
    expect(ProductAttributes.safeParse({ category: 'cars' }).success).toBe(false);
  });
});

describe('PhotoCredit', () => {
  const credit = {
    imageKey: KEY,
    photographer: 'Roman Odintsov',
    profileUrl: 'https://www.pexels.com/@roman-odintsov/',
    sourceUrl: 'https://www.pexels.com/photo/close-up-shot-of-skincare-products-7691112/',
    site: 'Pexels',
  };

  it('accepts https links', () => {
    expect(PhotoCredit.parse(credit)).toEqual(credit);
  });

  // Credits are rendered as <a href>, and products.attributes is written from approved listings (M8).
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://www.pexels.com/@roman-odintsov/',
    'https://localhost/admin',
  ])('rejects %s as a link', (url) => {
    expect(PhotoCredit.safeParse({ ...credit, profileUrl: url }).success).toBe(false);
    expect(PhotoCredit.safeParse({ ...credit, sourceUrl: url }).success).toBe(false);
  });
});

describe('DropSummary and ProductDetail', () => {
  it('round-trips a drop summary', () => {
    const summary = {
      ...drop,
      product,
      stock: { avail: 180, held: 5, sold: 15, status: 'LIVE', gen: 0, seq: 0 },
    };

    expect(DropSummary.parse(summary)).toEqual(summary);
  });

  it('allows a product without a drop', () => {
    const detail = {
      product: { ...product, description: 'Over-ear headphones.', attributes: ProductAttributes.parse({}) },
      drop: null,
    };

    expect(ProductDetail.parse(detail)).toEqual(detail);
  });

  it('never serves a DRAFT drop', () => {
    expect(ProductDetail.shape.drop.safeParse({ ...drop, status: 'DRAFT' }).success).toBe(false);
  });
});

describe('StockSnapshot', () => {
  const snapshot = {
    avail: 0,
    held: 2,
    sold: 48,
    status: 'RECONCILING',
    gen: -1,
    seq: 0,
    serverNow: '2026-10-02T10:00:00.000Z',
  };

  it('accepts the fail-closed state of a drop that is being rebuilt', () => {
    expect(StockSnapshot.parse(snapshot)).toEqual(snapshot);
  });

  it.each([{ avail: -1 }, { gen: -2 }, { seq: 1.5 }, { serverNow: '2026-10-02 10:00' }])(
    'rejects %j',
    (patch) => {
      expect(StockSnapshot.safeParse({ ...snapshot, ...patch }).success).toBe(false);
    },
  );
});

describe('ImageKey', () => {
  it('is a content-addressed JPEG served under /uploads', () => {
    expect(ImageKey.parse(KEY)).toBe(KEY);
    expect(uploadPath(KEY)).toBe(`/uploads/${KEY}`);
    expect(ImageKey.safeParse('../etc/passwd').success).toBe(false);
    expect(ImageKey.safeParse(`${'A'.repeat(64)}.jpg`).success).toBe(false);
  });
});

describe('ProblemDetails', () => {
  it('fills the RFC 9457 default type', () => {
    expect(ProblemDetails.parse({ title: 'Sold out', status: 409, code: 'SOLD_OUT' })).toEqual({
      type: 'about:blank',
      title: 'Sold out',
      status: 409,
      code: 'SOLD_OUT',
    });
  });

  it('rejects unknown codes and non-error statuses', () => {
    expect(ProblemDetails.safeParse({ title: 'x', status: 409, code: 'NOPE' }).success).toBe(false);
    expect(ProblemDetails.safeParse({ title: 'x', status: 200, code: 'CONFLICT' }).success).toBe(false);
  });
});
