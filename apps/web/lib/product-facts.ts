import type { ProductAttributes, ProductCategory, ProductCondition } from '@flashdrop/contracts';

const categoryLabel: Readonly<Record<ProductCategory, string>> = {
  apparel: 'Apparel',
  audio: 'Audio',
  bags: 'Bags',
  beauty: 'Beauty',
  eyewear: 'Eyewear',
  footwear: 'Footwear',
  fragrance: 'Fragrance',
  home: 'Home',
  tech: 'Tech',
  watches: 'Watches',
};

const conditionLabel: Readonly<Record<ProductCondition, string>> = {
  new: 'New',
  used: 'Used',
  refurbished: 'Refurbished',
};

export type ProductFact = { key: string; value: string };

/**
 * The product page's "Details" rows (§10.2), only those with a value: a product without attributes (every
 * test product, and any listing published without them) has none, and the page leaves out the group rather
 * than show a heading over nothing.
 */
export function productFacts(attributes: ProductAttributes): ProductFact[] {
  const { brand, color, material, size, condition, category } = attributes;
  const rows: { key: string; value: string | null }[] = [
    { key: 'Brand', value: brand },
    { key: 'Color', value: color },
    { key: 'Material', value: material },
    { key: 'Size', value: size },
    { key: 'Condition', value: condition && conditionLabel[condition] },
    { key: 'Category', value: category && categoryLabel[category] },
  ];
  return rows.filter((row): row is ProductFact => row.value !== null && row.value !== '');
}
