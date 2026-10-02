/**
 * Checks the seed media against the rules it promises: the listing rules of design §10 for every product,
 * clean web JPEGs with a credit and licence for every photo, and an HLS loop that matches the storyboard.
 * Prints a summary and exits non-zero on any problem.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  CATALOG_DIR,
  type CatalogImage,
  catalogSource,
  container,
  HLS_DIR,
  loopSeconds,
  PHOTO_MAX_BYTES,
  PHOTO_MAX_EDGE,
  type Product,
  productOf,
  SEGMENT_SECONDS,
  storyboard,
} from './media';

const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const BANNED_CLAIMS = /\b(authentic|guaranteed)\b|100% original/i;
const PRICE_OR_CURRENCY = /[$€£¥]|\b(USD|EUR|GBP)\b|\b\d+(\.\d+)?\s?(dollars?|cents?)\b/i;

const problems: string[] = [];
const check = (ok: boolean, problem: string) => {
  if (!ok) problems.push(problem);
};

function checkListing(product: Product<unknown>): void {
  const { slug, title, description, highlights, tags, attributes } = product;
  const category = catalogSource.taxonomy.find((c) => c.id === product.category);
  check(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug), `${slug}: slug is not kebab-case`);
  check(category !== undefined, `${slug}: unknown category ${product.category}`);
  check(title.length >= 10 && title.length <= 80, `${slug}: title must be 10–80 characters`);
  check(title !== title.toUpperCase(), `${slug}: title is all caps`);
  check(
    description.length >= 80 && description.length <= 1200,
    `${slug}: description must be 80–1,200 characters`,
  );
  check(highlights.length >= 3 && highlights.length <= 6, `${slug}: needs 3–6 highlights`);
  check(
    highlights.every((h) => h.length <= 120),
    `${slug}: highlights must be at most 120 characters`,
  );
  check(tags.length >= 1 && tags.length <= 10, `${slug}: needs 1–10 tags`);
  check(product.condition === 'new', `${slug}: seed products are sold new`);
  check(attributes.brand === null, `${slug}: seed products are unbranded`);
  for (const attribute of category?.requiredAttributes ?? []) {
    const value = Object.entries(attributes).find(([key]) => key === attribute)?.[1];
    check(
      typeof value === 'string' && value.length > 0,
      `${slug}: ${product.category} requires ${attribute}`,
    );
  }
  const text = [title, description, ...highlights, ...tags].join('\n');
  check(!BANNED_CLAIMS.test(text), `${slug}: copy makes a banned claim`);
  check(!PRICE_OR_CURRENCY.test(text), `${slug}: copy mentions a price or currency`);
  check(
    Number.isInteger(product.suggestedPriceCents) && product.suggestedPriceCents > 0,
    `${slug}: bad price`,
  );
}

async function checkImage(slug: string, image: CatalogImage): Promise<number> {
  const file = join(CATALOG_DIR, image.src);
  const [meta, { size }] = await Promise.all([sharp(file).metadata(), stat(file)]);
  const where = image.src;
  check(image.src.startsWith(`${slug}/`), `${where}: outside the product folder`);
  check(meta.format === 'jpeg' && meta.isProgressive === true, `${where}: not a progressive JPEG`);
  check(meta.space === 'srgb', `${where}: not sRGB`);
  check(
    !meta.exif && !meta.icc && !meta.xmp && !meta.iptc && !meta.orientation,
    `${where}: carries metadata`,
  );
  check(
    meta.width === image.width && meta.height === image.height,
    `${where}: size differs from catalog.json`,
  );
  check(Math.max(image.width, image.height) <= PHOTO_MAX_EDGE, `${where}: longer than ${PHOTO_MAX_EDGE} px`);
  check(size <= PHOTO_MAX_BYTES, `${where}: larger than ${PHOTO_MAX_BYTES / 1024} KB`);
  check(image.alt.length > 0, `${where}: no alt text`);
  check(/^#[0-9a-f]{6}$/.test(image.color), `${where}: bad backdrop colour`);
  check(image.credit.licence === 'Pexels License', `${where}: unexpected licence ${image.credit.licence}`);
  check(
    /^https:\/\/www\.pexels\.com\/photo\/[a-z0-9-]+-\d+\/$/.test(image.credit.source),
    `${where}: bad source`,
  );
  return size;
}

async function checkCatalog(): Promise<void> {
  const { products } = catalogSource;
  check(new Set(products.map((p) => p.slug)).size === products.length, 'duplicate product slugs');
  let bytes = 0;
  const images: CatalogImage[] = [];
  for (const product of products) {
    checkListing(product);
    for (const image of product.images) {
      const { width, height, color } = image;
      if (width === undefined || height === undefined || color === undefined) {
        problems.push(`${image.src}: not built yet (run build-catalog)`);
        continue;
      }
      const built = { ...image, width, height, color };
      images.push(built);
      bytes += await checkImage(product.slug, built);
    }
  }
  const listed = new Set(images.map((image) => image.src));
  for (const entry of await readdir(CATALOG_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of await readdir(join(CATALOG_DIR, entry.name))) {
      check(listed.has(`${entry.name}/${file}`), `${entry.name}/${file}: not in catalog.json`);
    }
  }
  const credits = await readFile(join(CATALOG_DIR, 'CREDITS.md'), 'utf8');
  for (const image of images) {
    check(credits.includes(`\`${image.src}\``), `${image.src}: missing from CREDITS.md`);
  }
  console.log(
    `catalog: ${products.length} products, ${images.length} images, ${(bytes / 1048576).toFixed(2)} MiB`,
  );
}

/** Reads one stream's fields from ffprobe's `flat` output (`streams.stream.<i>.<key>="value"`). */
function streamOf(fields: ReadonlyMap<string, string>, type: string): (key: string) => string | undefined {
  for (let i = 0; fields.has(`streams.stream.${i}.codec_type`); i++) {
    if (fields.get(`streams.stream.${i}.codec_type`) === type) {
      return (key) => fields.get(`streams.stream.${i}.${key}`);
    }
  }
  return () => undefined;
}

async function checkStream(): Promise<void> {
  const files = await readdir(HLS_DIR);
  const sizes = await Promise.all(files.map(async (file) => (await stat(join(HLS_DIR, file))).size));
  const bytes = sizes.reduce((a, b) => a + b, 0);
  check(
    !files.some((file) => file.endsWith('.ts')),
    'MPEG-TS segments would collide with TypeScript tooling',
  );
  check(bytes <= MAX_STREAM_BYTES, `stream is ${(bytes / 1048576).toFixed(2)} MiB`);

  const playlist = await readFile(join(HLS_DIR, 'live.m3u8'), 'utf8');
  const segments = playlist.split('\n').filter((line) => line.endsWith('.m4s'));
  const durations = [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
  const total = durations.reduce((a, b) => a + b, 0);
  check(playlist.includes('#EXT-X-MAP:URI="init.mp4"') && files.includes('init.mp4'), 'no fMP4 init segment');
  check(
    playlist.includes('#EXT-X-PLAYLIST-TYPE:VOD') && playlist.includes('#EXT-X-ENDLIST'),
    'not a VOD playlist',
  );
  check(segments.length === Math.ceil(loopSeconds / SEGMENT_SECONDS), `${segments.length} segments`);
  check(Math.abs(total - loopSeconds) < 0.05, `playlist lasts ${total} s, storyboard ${loopSeconds} s`);
  check(
    segments.every((segment) => files.includes(segment)),
    'playlist names a missing segment',
  );

  const mounts = { '/hls': HLS_DIR };
  const entries =
    'stream=codec_type,codec_name,profile,width,height,pix_fmt,avg_frame_rate,color_space,sample_rate,channels';
  const flat = await container(
    'ffprobe',
    ['-show_entries', `${entries}:format=duration`, '-of', 'flat', '/hls/live.m3u8'],
    mounts,
  );
  const fields = new Map(
    flat
      .trim()
      .split('\n')
      .map((line) => {
        const [key = '', value = ''] = line.trim().split('=');
        return [key, value.replace(/^"|"$/g, '')];
      }),
  );
  const video = streamOf(fields, 'video');
  const audio = streamOf(fields, 'audio');
  const duration = Number(fields.get('format.duration'));
  const { width: W, height: H, fps } = storyboard;
  check(video('codec_name') === 'h264' && video('profile') === 'High', 'video is not H.264 High');
  check(video('width') === String(W) && video('height') === String(H), `video is not ${W}×${H}`);
  check(
    video('avg_frame_rate') === `${fps}/1` && video('pix_fmt') === 'yuv420p',
    `video is not ${fps} fps 4:2:0`,
  );
  check(video('color_space') === 'bt709', 'video is not tagged BT.709');
  check(
    audio('codec_name') === 'aac' && audio('sample_rate') === '48000' && audio('channels') === '2',
    'no 48 kHz stereo AAC track',
  );
  check(Math.abs(duration - loopSeconds) < 0.1, `stream lasts ${duration} s`);

  // Every segment must open on a keyframe, or players stall when they start mid-stream.
  const packets = await container(
    'ffprobe',
    ['-select_streams', 'v', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', '/hls/live.m3u8'],
    mounts,
  );
  const rows = packets
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  const start = Number(rows[0]?.[0]);
  const keyframes = rows.filter(([, flags]) => flags?.startsWith('K')).map(([time]) => Number(time) - start);
  for (let t = 0; t < loopSeconds; t += SEGMENT_SECONDS) {
    check(
      keyframes.some((k) => Math.abs(k - t) < 0.5 / fps),
      `no keyframe at ${t} s`,
    );
  }

  const poster = await sharp(join(HLS_DIR, 'poster.jpg')).metadata();
  check(poster.width === W && poster.height === H, 'poster is not frame-sized');

  const vtt = await readFile(join(HLS_DIR, 'captions.en.vtt'), 'utf8');
  const cues = [...vtt.matchAll(/^([a-z0-9-]+)\n([\d:.]+) --> ([\d:.]+)$/gm)];
  const seconds = (stamp = '') => stamp.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  const slugs = new Set(catalogSource.products.map((p) => p.slug));
  check(vtt.startsWith('WEBVTT\n'), 'captions are not WebVTT');
  check(
    cues.length === storyboard.shots.length,
    `${cues.length} caption cues for ${storyboard.shots.length} shots`,
  );
  cues.forEach(([, id = '', from, to], k) => {
    const shot = storyboard.shots[k];
    check(shot !== undefined && id === productOf(shot), `cue ${k + 1} is ${id}, not the product on screen`);
    check(slugs.has(id), `cue ${id} is not a catalog product`);
    check(seconds(from) < seconds(to) && seconds(to) <= loopSeconds, `cue ${id} has bad timing`);
  });
  console.log(
    `stream: ${segments.length} × ${SEGMENT_SECONDS} s fMP4 segments, ${total} s, ${(bytes / 1048576).toFixed(2)} MiB, ` +
      `H.264 ${video('profile')} ${video('width')}×${video('height')} + ${audio('codec_name')}, ${cues.length} cues`,
  );
}

await checkCatalog();
await checkStream();
for (const shot of storyboard.shots) {
  check(
    catalogSource.products.some((p) => p.images.some((image) => image.src === shot.image)),
    `storyboard: ${shot.image} is not a catalog image`,
  );
}
if (problems.length > 0) {
  console.error(problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('all checks passed');
}
