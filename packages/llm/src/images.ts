import { createHash } from 'node:crypto';
import type { ImageKey } from '@flashdrop/contracts';
import sharp from 'sharp';

/*
 * Listing photo preparation (design §10): auto-orient, a long edge of at most 1568 px (the size the vision
 * models use without downscaling again), re-encoded as JPEG q85. Re-encoding writes no metadata, so EXIF
 * and GPS never reach storage, the model or a product page; colours are converted to sRGB on the way.
 */

export const LISTING_IMAGE = {
  maxEdge: 1_568,
  quality: 85,
  /**
   * Refuses a decompression bomb before decoding: an 8 MB PNG can declare a gigapixel canvas. 50 MP covers
   * every phone and DSLR photo.
   */
  maxInputPixels: 50_000_000,
} as const;

export interface PreparedImage {
  /** `<sha256>.jpg` of the re-encoded bytes: the file name under `UPLOAD_DIR` and the photo's identity. */
  readonly key: ImageKey;
  readonly sha256: string;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Re-encodes one uploaded photo (JPEG, PNG or WebP, already magic-byte checked). Throws sharp's error for
 * input it cannot decode; callers answer that as invalid input. Transparent areas become white, the
 * backdrop a product photo is expected to have, rather than JPEG's default black.
 */
export async function prepareListingImage(input: Uint8Array): Promise<PreparedImage> {
  const { data, info } = await sharp(input, { limitInputPixels: LISTING_IMAGE.maxInputPixels })
    .rotate()
    .resize({
      width: LISTING_IMAGE.maxEdge,
      height: LISTING_IMAGE.maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: LISTING_IMAGE.quality })
    .toBuffer({ resolveWithObject: true });
  const sha256 = sha256Hex(data);
  return { key: `${sha256}.jpg`, sha256, bytes: data, width: info.width, height: info.height };
}
