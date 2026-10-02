import { ProductAttributes } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import { availability, productJsonLd, serializeJsonLd } from './json-ld';
import type { StockState } from './stock';

const live = (avail: number, held: number, sold: number): StockState => ({
  status: 'LIVE',
  avail,
  held,
  sold,
});

describe('availability', () => {
  it('is in stock only while a live drop has units left', () => {
    expect(availability(live(200, 10, 40), false)).toBe('InStock');
    expect(availability(live(4, 10, 236), true)).toBe('LimitedAvailability');
    expect(availability({ ...live(250, 0, 0), status: 'SCHEDULED' }, false)).toBe('OutOfStock');
    expect(availability({ ...live(20, 0, 230), status: 'PAUSED' }, false)).toBe('OutOfStock');
  });

  it('tells units in carts from units sold', () => {
    expect(availability(live(0, 3, 247), false)).toBe('OutOfStock');
    expect(availability(live(0, 0, 250), false)).toBe('SoldOut');
    expect(availability({ ...live(0, 0, 50), status: 'ENDED' }, false)).toBe('SoldOut');
    expect(availability({ ...live(8, 0, 42), status: 'ENDED' }, false)).toBe('OutOfStock');
  });
});

const product = {
  id: '5eed0003-0000-4000-8000-000000000001',
  slug: 'sage-wireless-headphones',
  title: 'Sage </script> Headphones',
  imageKeys: [],
  description: 'Plush cushions.',
  attributes: ProductAttributes.parse({ condition: 'new', brand: 'Sage' }),
};

const drop = {
  id: '5eed0004-0000-4000-8000-000000000001',
  status: 'LIVE',
  startsAt: '2026-10-02T17:09:00.000Z',
  endsAt: '2026-10-02T21:00:00.000Z',
  priceCents: 14_900,
  currency: 'USD',
  perUserLimit: 2,
  holdSeconds: 120,
  room: null,
} as const;

describe('productJsonLd', () => {
  it('describes the product and its offer', () => {
    const data = productJsonLd({
      product,
      drop,
      stock: live(250, 0, 0),
      urgent: false,
      pageUrl: 'http://127.0.0.1:8080/p/sage-wireless-headphones',
      imageUrls: ['http://127.0.0.1:8080/uploads/a.jpg'],
    });
    expect(data).toMatchObject({
      '@type': 'Product',
      brand: { '@type': 'Brand', name: 'Sage' },
      offers: {
        '@type': 'Offer',
        price: '149.00',
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        itemCondition: 'https://schema.org/NewCondition',
      },
    });
  });

  it('has no offer without a drop', () => {
    const data = productJsonLd({
      product,
      drop: null,
      stock: null,
      urgent: false,
      pageUrl: 'x',
      imageUrls: [],
    });
    expect(data).not.toHaveProperty('offers');
  });
});

describe('serializeJsonLd', () => {
  it('cannot close the script element', () => {
    const json = serializeJsonLd({ name: product.title });
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json)).toEqual({ name: product.title });
  });
});
