import type { PhotoCredit, Product, ProductCategory, ProductCondition } from '@flashdrop/contracts';
import { Check } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { KeyValueList } from '../ui/key-value-list';

const categoryLabel: Record<ProductCategory, string> = {
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

const conditionLabel: Record<ProductCondition, string> = {
  new: 'New',
  used: 'Used',
  refurbished: 'Refurbished',
};

/**
 * Everything about the product below the purchase area (§10.2): highlights, the description, the facts and
 * the photo credit. It shares the `page-wide` 12-column grid of the gallery and panel above it, so the page
 * keeps one left edge: from 1069 px each heading takes columns 1–3 and its content columns 4–10, a readable
 * measure. The hairline above is the only separator; the space around it is the layout's (§1.4).
 */
export function ProductDetails({ product }: { product: Product }) {
  const { highlights, brand, color, material, size, condition, category, photoCredits } = product.attributes;

  return (
    <section
      aria-label="Product details"
      className="page-wide border-separator border-t pt-12 pb-(--section-space) md:pt-16"
    >
      <div className="flex flex-col gap-12 md:gap-16">
        {highlights.length > 0 && (
          <DetailGroup title="Highlights">
            <ul className="flex max-w-text flex-col gap-3">
              {highlights.map((highlight) => (
                <li key={highlight} className="flex gap-3">
                  <Check className="mt-0.5 shrink-0 text-label-secondary" />
                  {highlight}
                </li>
              ))}
            </ul>
          </DetailGroup>
        )}
        {product.description && (
          <DetailGroup title="Description">
            <p className="max-w-text">{product.description}</p>
          </DetailGroup>
        )}
        <DetailGroup title="Details">
          <KeyValueList
            size="body"
            className="max-w-text"
            rows={[
              { key: 'Brand', value: brand },
              { key: 'Color', value: color },
              { key: 'Material', value: material },
              { key: 'Size', value: size },
              { key: 'Condition', value: condition && conditionLabel[condition] },
              { key: 'Category', value: category && categoryLabel[category] },
            ]}
          />
        </DetailGroup>
        {photoCredits.length > 0 && <Credits credits={photoCredits} />}
      </div>
    </section>
  );
}

function DetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 md:grid-cols-12 md:gap-(--grid-gap)">
      <h2 className="text-title-3 md:col-span-3">{title}</h2>
      <div className="md:col-span-7">{children}</div>
    </section>
  );
}

/**
 * "Photo: {name} on Pexels" for stock photos (§11.1), one name per photographer. Links in running text are
 * underlined (§2.7).
 */
function Credits({ credits }: { credits: readonly PhotoCredit[] }) {
  const photographers = [
    ...new Map(credits.map((credit) => [`${credit.photographer}|${credit.site}`, credit])).values(),
  ];
  return (
    <p className="text-footnote text-label-secondary md:grid md:grid-cols-12 md:gap-(--grid-gap)">
      <span className="md:col-span-7 md:col-start-4">
        {credits.length === 1 ? 'Photo: ' : 'Photos: '}
        {photographers.map((credit, index) => (
          <Fragment key={`${credit.photographer}|${credit.site}`}>
            {index > 0 && (index === photographers.length - 1 ? ' and ' : ', ')}
            <a
              href={credit.profileUrl}
              rel="noopener"
              className="underline decoration-1 underline-offset-4 transition-colors duration-200 ease-standard hover:text-label"
            >
              {credit.photographer}
            </a>{' '}
            on {credit.site}
          </Fragment>
        ))}
      </span>
    </p>
  );
}
