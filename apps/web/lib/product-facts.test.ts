import { ProductAttributes } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import { productFacts } from './product-facts';

describe('productFacts', () => {
  it('has no rows for a product without attributes, so the page leaves out "Details"', () => {
    expect(productFacts(ProductAttributes.parse({}))).toEqual([]);
  });

  it('keeps the rows with a value, in order, in words', () => {
    const attributes = ProductAttributes.parse({
      brand: 'Halo',
      color: 'Sage',
      condition: 'new',
      category: 'audio',
    });
    expect(productFacts(attributes)).toEqual([
      { key: 'Brand', value: 'Halo' },
      { key: 'Color', value: 'Sage' },
      { key: 'Condition', value: 'New' },
      { key: 'Category', value: 'Audio' },
    ]);
  });
});
