import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Cents,
  Currency,
  HttpsUrl,
  ProductCategory,
  ProductCondition,
  SLUG_PATTERN,
  Slug,
} from '@flashdrop/contracts';
import { z } from 'zod';

/*
 * `assets/catalog/catalog.json`, the hand-edited seed catalog (assets/README.md). Only the fields the seed
 * stores are validated; the media pipeline owns the rest (dimensions, colours, edits).
 */

const LICENCE_SITES = { 'Pexels License': 'Pexels', 'Unsplash License': 'Unsplash' } as const;

const CatalogImage = z.object({
  // A photo inside the catalog folder; the pattern also rules out path traversal.
  src: z.string().regex(new RegExp(`^${SLUG_PATTERN}/\\d+\\.jpg$`), 'must be <slug>/<n>.jpg'),
  credit: z.object({
    photographer: z.string().min(1),
    profile: HttpsUrl,
    source: HttpsUrl,
    licence: z.enum(['Pexels License', 'Unsplash License']).transform((licence) => LICENCE_SITES[licence]),
  }),
});

const optionalText = z.string().min(1).nullable();

const CatalogProduct = z.object({
  slug: Slug,
  title: z.string().min(10).max(80),
  description: z.string().min(1),
  category: ProductCategory,
  condition: ProductCondition,
  attributes: z.object({
    brand: optionalText,
    color: optionalText,
    material: optionalText,
    size: optionalText,
  }),
  highlights: z.array(z.string().min(1)),
  tags: z.array(z.string().min(1)),
  suggestedPriceCents: Cents,
  images: z.array(CatalogImage).min(1),
});

export const SeedCatalog = z.object({
  currency: Currency,
  products: z.array(CatalogProduct).min(1),
});
export type SeedCatalog = z.output<typeof SeedCatalog>;
export type SeedCatalogProduct = SeedCatalog['products'][number];

/** `assets/catalog` in the repository, for the scripts that run from source. */
export const REPO_CATALOG_DIR = fileURLToPath(new URL('../../../../assets/catalog', import.meta.url));

export async function loadCatalog(catalogDir: string): Promise<SeedCatalog> {
  const text = await readFile(join(catalogDir, 'catalog.json'), 'utf8');
  return SeedCatalog.parse(JSON.parse(text));
}
