/**
 * Rebuilds the catalog photos from their Pexels originals and refreshes everything derived from them.
 *
 * For every image in assets/catalog/catalog.json: download the original once (cached in CACHE_DIR),
 * auto-orient, apply the image's `edit` (crop, retouch), resize to a 2,000 px long edge and encode a
 * progressive sRGB JPEG under 450 KB with no metadata. Then rewrite the derived fields of catalog.json
 * (width, height, color), regenerate CREDITS.md and delete files the catalog no longer references.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import {
  CACHE_DIR,
  CATALOG_DIR,
  type CatalogImage,
  type CatalogImageSource,
  catalogSource,
  formatJson,
  PHOTO_MAX_BYTES,
  PHOTO_MAX_EDGE,
  type Rect,
} from './media';

const QUALITY = 82;
const MIN_QUALITY = 70;
/** In pixels of the finished image: wider than a printed glyph stroke, narrower than the shapes around it. */
const RETOUCH_MEDIAN = 15;
const RETOUCH_FEATHER = 14;

interface Raw {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

const rawInput = ({ width, height, channels }: Raw) => ({ raw: { width, height, channels } });

function pexelsId(source: string): number {
  const id = /-(\d+)\/$/.exec(source)?.[1];
  if (!id) throw new Error(`Not a Pexels photo page: ${source}`);
  return Number(id);
}

async function original(id: number): Promise<string> {
  const file = join(CACHE_DIR, 'originals', `${id}.jpg`);
  if (!existsSync(file)) {
    const res = await fetch(`https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?cs=srgb&fm=jpg`);
    if (!res.ok) throw new Error(`Downloading Pexels photo ${id} failed: HTTP ${res.status}`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

function toPixels(rect: Rect, width: number, height: number) {
  const [x = 0, y = 0, w = 0, h = 0] = rect;
  if (rect.length !== 4 || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) {
    throw new Error(`Bad region [${rect.join(', ')}]`);
  }
  const left = Math.round(x * width);
  const top = Math.round(y * height);
  return {
    left,
    top,
    width: Math.min(width - left, Math.round(w * width)),
    height: Math.min(height - top, Math.round(h * height)),
  };
}

async function decode(image: CatalogImageSource): Promise<Raw> {
  const file = await original(pexelsId(image.credit.source));
  const { autoOrient } = await sharp(file).metadata();
  let pipeline = sharp(file).autoOrient();
  if (image.edit?.crop) {
    pipeline = pipeline.extract(toPixels(image.edit.crop, autoOrient.width, autoOrient.height));
  }
  const { data, info } = await pipeline
    .resize(PHOTO_MAX_EDGE, PHOTO_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Median-filters each region and blends it back through a feathered mask, so no seam shows. */
async function retouch(image: Raw, regions: readonly Rect[]): Promise<Raw> {
  const overlays = await Promise.all(
    regions.map(async (region) => {
      const box = toPixels(region, image.width, image.height);
      // Filter a padded patch so the pixels at the patch edge see their real neighbours.
      const left = Math.max(0, box.left - RETOUCH_MEDIAN);
      const top = Math.max(0, box.top - RETOUCH_MEDIAN);
      const padded = {
        left,
        top,
        width: Math.min(image.width, box.left + box.width + RETOUCH_MEDIAN) - left,
        height: Math.min(image.height, box.top + box.height + RETOUCH_MEDIAN) - top,
      };
      const filtered = await sharp(image.data, rawInput(image))
        .extract(padded)
        .median(RETOUCH_MEDIAN)
        .raw()
        .toBuffer();
      const patch = await sharp(filtered, {
        raw: { width: padded.width, height: padded.height, channels: 3 },
      })
        .extract({ left: box.left - left, top: box.top - top, width: box.width, height: box.height })
        .raw()
        .toBuffer();
      const f = RETOUCH_FEATHER;
      const shape = `<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height}"><rect x="${f}" y="${f}" width="${box.width - 2 * f}" height="${box.height - 2 * f}" rx="${f}" fill="#fff"/></svg>`;
      const mask = await sharp(Buffer.from(shape))
        .blur(f / 2)
        .extractChannel(0)
        .raw()
        .toBuffer();
      const input = await sharp(patch, { raw: { width: box.width, height: box.height, channels: 3 } })
        .joinChannel(mask, { raw: { width: box.width, height: box.height, channels: 1 } })
        .png()
        .toBuffer();
      return { input, left: box.left, top: box.top };
    }),
  );
  const flattened = await sharp(image.data, rawInput(image)).composite(overlays).png().toBuffer();
  const { data, info } = await sharp(flattened).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

async function encode(image: Raw, label: string): Promise<{ data: Buffer; quality: number }> {
  for (let quality = QUALITY; quality >= MIN_QUALITY; quality -= 2) {
    const data = await sharp(image.data, rawInput(image))
      .jpeg({ quality, progressive: true, mozjpeg: true })
      .toBuffer();
    if (data.length <= PHOTO_MAX_BYTES) return { data, quality };
  }
  throw new Error(`${label} stays above ${PHOTO_MAX_BYTES / 1024} KB even at quality ${MIN_QUALITY}`);
}

/** Mean colour of a thin border: a calm placeholder that matches the backdrop rather than the product. */
async function backdropColor(image: Raw): Promise<string> {
  const size = 32;
  const { data } = await sharp(image.data, rawInput(image))
    .resize(size, size, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x > 1 && x < size - 2 && y > 1 && y < size - 2) continue;
      for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (data[(y * size + x) * 3 + c] ?? 0);
      count++;
    }
  }
  const hex = (total: number) =>
    Math.round(total / count)
      .toString(16)
      .padStart(2, '0');
  return `#${sum.map(hex).join('')}`;
}

async function build(image: CatalogImageSource): Promise<CatalogImage> {
  let raw = await decode(image);
  if (image.edit?.retouch) raw = await retouch(raw, image.edit.retouch);
  const { data, quality } = await encode(raw, image.src);
  await mkdir(dirname(join(CATALOG_DIR, image.src)), { recursive: true });
  await writeFile(join(CATALOG_DIR, image.src), data);
  console.log(
    `${image.src.padEnd(36)} ${`${raw.width}×${raw.height}`.padEnd(10)} q${quality} ${String(Math.round(data.length / 1024)).padStart(4)} KB`,
  );
  const { src, alt, credit, edit } = image;
  return {
    src,
    width: raw.width,
    height: raw.height,
    alt,
    color: await backdropColor(raw),
    credit,
    ...(edit && { edit }),
  };
}

/** Deletes product folders and photos that the catalog no longer lists. */
async function prune(keep: ReadonlySet<string>): Promise<void> {
  for (const entry of await readdir(CATALOG_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(join(CATALOG_DIR, entry.name));
    const stale = files.filter((file) => !keep.has(`${entry.name}/${file}`));
    if (stale.length === files.length) {
      await rm(join(CATALOG_DIR, entry.name), { recursive: true });
      continue;
    }
    for (const file of stale) await rm(join(CATALOG_DIR, entry.name, file));
  }
}

function credits(images: readonly CatalogImage[]): string {
  const rows = images.map(({ src, credit, edit }) => {
    const notes = [edit?.crop && 'cropped', edit?.retouch && 'retouched'].filter(Boolean).join(', ');
    const file = notes ? `\`${src}\` (${notes})` : `\`${src}\``;
    return `| ${file} | [${credit.photographer}](${credit.profile}) | [Pexels photo](${credit.source}) | ${credit.licence} |`;
  });
  return [
    '# Catalog photo credits',
    '',
    'Every photo in this folder comes from [Pexels](https://www.pexels.com) and is used under the',
    '[Pexels License](https://www.pexels.com/license/): free to use and modify; attribution is not required but',
    'is given here. Each file was re-encoded for the web: auto-oriented, resized to a 2,000 px long edge and',
    'stripped of metadata. Files marked *cropped* were cropped to keep the product centred; in files marked',
    '*retouched*, label text showing through the glass was smoothed away.',
    '',
    '| File | Photographer | Source | Licence |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

const products = [];
for (const product of catalogSource.products) {
  for (const image of product.images) {
    if (image.credit.licence !== 'Pexels License') throw new Error(`${image.src}: unexpected licence`);
    if (!image.src.startsWith(`${product.slug}/`)) {
      throw new Error(`${image.src} is outside ${product.slug}/`);
    }
  }
  const images = [];
  for (const image of product.images) images.push(await build(image));
  products.push({ ...product, images });
}

const all = products.flatMap((product) => product.images);
await prune(new Set(all.map((image) => image.src)));
await writeFile(join(CATALOG_DIR, 'catalog.json'), formatJson({ ...catalogSource, products }));
await writeFile(join(CATALOG_DIR, 'CREDITS.md'), credits(all));
console.log(`${products.length} products, ${all.length} images`);
