import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { prepareListingImage, sha256Hex } from './images';

/** A landscape JPEG with EXIF (camera, orientation 6 = rotate 90° on display) and a GPS position. */
async function cameraPhoto(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#4a7a5c' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: 'FlashCam', Model: 'X1' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '48/1 51/1 29/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '2/1 17/1 40/1',
      },
    })
    .toBuffer();
}

describe('prepareListingImage', () => {
  it('auto-orients, bounds the long edge to 1568 px and strips EXIF and GPS', async () => {
    const input = await cameraPhoto(3000, 2000);
    expect((await sharp(input).metadata()).orientation).toBe(6);
    expect(input.includes(Buffer.from('FlashCam'))).toBe(true);

    const prepared = await prepareListingImage(input);
    const metadata = await sharp(prepared.bytes).metadata();
    expect(metadata.format).toBe('jpeg');
    // Orientation 6 turns the 3000 x 2000 landscape into a portrait.
    expect([metadata.width, metadata.height]).toEqual([1045, 1568]);
    expect([prepared.width, prepared.height]).toEqual([1045, 1568]);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(prepared.bytes.includes(Buffer.from('FlashCam'))).toBe(false);
  });

  it('names the file by the sha256 of the bytes it stores', async () => {
    const prepared = await prepareListingImage(await cameraPhoto(800, 600));
    expect(prepared.sha256).toBe(sha256Hex(prepared.bytes));
    expect(prepared.key).toBe(`${prepared.sha256}.jpg`);
  });

  it('never enlarges, and flattens transparency onto white', async () => {
    const png = await sharp({
      create: { width: 40, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const prepared = await prepareListingImage(png);
    expect([prepared.width, prepared.height]).toEqual([40, 30]);
    const { data } = await sharp(prepared.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(Math.min(...data)).toBeGreaterThan(245);
  });

  it('re-encodes WebP too', async () => {
    const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c0ffee' } })
      .webp()
      .toBuffer();
    expect((await sharp((await prepareListingImage(webp)).bytes).metadata()).format).toBe('jpeg');
  });

  it('throws on bytes that are not a decodable image', async () => {
    await expect(prepareListingImage(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]))).rejects.toThrow();
  });
});
