import type { DropInfo, Product, ProductCondition } from '@flashdrop/contracts';
import type { StockState } from './stock';

/*
 * schema.org `Product` with an `Offer` for the product page (SD §8.1). Availability is computed from the same
 * stock snapshot the page shows, so search engines never see a different state than buyers.
 */

const SCHEMA = 'https://schema.org/';

type Availability = 'InStock' | 'LimitedAvailability' | 'OutOfStock' | 'SoldOut';

/**
 * Only a LIVE drop with units left can be bought now. An upcoming or paused drop is out of stock until it
 * opens (`availabilityStarts` says when); one whose every unit sold is sold out.
 */
export function availability(stock: StockState, urgent: boolean): Availability {
  if (stock.avail === 0 && stock.held === 0) return 'SoldOut';
  if (stock.status !== 'LIVE' || stock.avail === 0) return 'OutOfStock';
  return urgent ? 'LimitedAvailability' : 'InStock';
}

const conditions: Record<ProductCondition, string> = {
  new: 'NewCondition',
  used: 'UsedCondition',
  refurbished: 'RefurbishedCondition',
};

type ProductJsonLdInput = {
  product: Product;
  drop: DropInfo | null;
  stock: StockState | null;
  urgent: boolean;
  /** Absolute URLs. */
  pageUrl: string;
  imageUrls: readonly string[];
};

export function productJsonLd({ product, drop, stock, urgent, pageUrl, imageUrls }: ProductJsonLdInput) {
  const { brand, condition } = product.attributes;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    description: product.description,
    url: pageUrl,
    image: imageUrls,
    ...(brand ? { brand: { '@type': 'Brand', name: brand } } : {}),
    ...(drop && stock
      ? {
          offers: {
            '@type': 'Offer',
            url: pageUrl,
            price: (drop.priceCents / 100).toFixed(2),
            priceCurrency: drop.currency,
            availability: `${SCHEMA}${availability(stock, urgent)}`,
            availabilityStarts: drop.startsAt,
            availabilityEnds: drop.endsAt,
            ...(condition ? { itemCondition: `${SCHEMA}${conditions[condition]}` } : {}),
          },
        }
      : {}),
  };
}

/**
 * JSON for an inline `<script type="application/ld+json">`. `<` is escaped so text from a listing can never
 * close the script element.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
