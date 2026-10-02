/**
 * Shared pieces of the seed-media pipeline: where things live, the shapes of the two hand-edited sources
 * (`assets/catalog/catalog.json` and `assets/storyboard.json`) and the pinned ffmpeg container.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import catalogJson from '../catalog/catalog.json' with { type: 'json' };
import storyboardJson from '../storyboard.json' with { type: 'json' };

function findRoot(from: string): string {
  for (let dir = from; dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
  }
  throw new Error(`No pnpm-workspace.yaml above ${from}`);
}

export const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));
export const CATALOG_DIR = join(ROOT, 'assets', 'catalog');
export const HLS_DIR = join(ROOT, 'apps', 'web', 'public', 'hls');
/** Downloaded originals and render intermediates stay out of the repo. */
export const CACHE_DIR = process.env.MEDIA_CACHE ?? join(tmpdir(), 'flashdrop-media');

/** Catalog photos: longest edge in pixels, and file size in bytes. */
export const PHOTO_MAX_EDGE = 2000;
export const PHOTO_MAX_BYTES = 450 * 1024;

/** A region as fractions of an image: `[left, top, width, height]`. */
export type Rect = readonly number[];

export interface Credit {
  photographer: string;
  profile: string;
  /** The photo's Pexels page; its trailing number is the photo id the original is downloaded by. */
  source: string;
  licence: string;
}

export interface ImageEdit {
  /** Applied to the auto-oriented original, before resizing. */
  crop?: Rect;
  /** Regions of the finished image smoothed with a median filter, e.g. label text seen through glass. */
  retouch?: readonly Rect[];
}

export interface CatalogImage {
  src: string;
  width: number;
  height: number;
  alt: string;
  /** Mean colour of the image border, shown while the photo loads. */
  color: string;
  credit: Credit;
  edit?: ImageEdit;
}

export interface Attributes {
  brand: string | null;
  color: string | null;
  material: string | null;
  size: string | null;
}

export interface Product<Image> {
  slug: string;
  title: string;
  description: string;
  category: string;
  condition: string;
  attributes: Attributes;
  highlights: readonly string[];
  tags: readonly string[];
  suggestedPriceCents: number;
  images: readonly Image[];
}

export interface Category {
  id: string;
  label: string;
  requiredAttributes: readonly string[];
}

export interface Catalog<Image = CatalogImage> {
  currency: string;
  taxonomy: readonly Category[];
  products: readonly Product<Image>[];
}

/** An image as authored: `build-catalog` derives the size and colour from the encoded file. */
export type CatalogImageSource = Omit<CatalogImage, 'width' | 'height' | 'color'> &
  Partial<Pick<CatalogImage, 'width' | 'height' | 'color'>>;

export const catalogSource: Catalog<CatalogImageSource> = catalogJson;

export interface Camera {
  zoom: number;
  x: number;
  y: number;
}

export interface Shot {
  /** Catalog image, relative to `assets/catalog`; its folder is the product slug. */
  image: string;
  /** Mirrors this fraction of the width onto each side, so a portrait shot on a seamless backdrop fills 16:9. */
  widen?: number;
  from: Camera;
  to: Camera;
  caption: string;
}

export interface Storyboard {
  width: number;
  height: number;
  fps: number;
  shotSeconds: number;
  fadeSeconds: number;
  shots: readonly Shot[];
}

export const storyboard: Storyboard = storyboardJson;

/** Shot k is fully on screen from k × step; consecutive shots overlap by `fadeSeconds`. */
export const shotStep = storyboard.shotSeconds - storyboard.fadeSeconds;
export const loopSeconds = storyboard.shots.length * shotStep;
/** HLS segment length; a whole number of 2 s GOPs, so every segment opens on a keyframe. */
export const SEGMENT_SECONDS = 4;

export const productOf = (shot: Shot): string => dirname(shot.image);

/** Pinned by tag and digest, like the Compose images (design §14). */
export const FFMPEG_IMAGE =
  'linuxserver/ffmpeg:9.0-cli-ls84@sha256:a7182d4fe498feea393622b43513cfaecb3fd073dcd3c7f38e9d74a10a4e8702';

/** Runs ffmpeg or ffprobe in the pinned container with `mounts` (container path → host path); resolves stdout. */
export function container(
  tool: 'ffmpeg' | 'ffprobe',
  args: readonly string[],
  mounts: Readonly<Record<string, string>>,
): Promise<string> {
  const volumes = Object.entries(mounts).flatMap(([inside, host]) => ['-v', `${host}:${inside}`]);
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      ...volumes,
      '--entrypoint',
      tool,
      FFMPEG_IMAGE,
      '-hide_banner',
      '-loglevel',
      'error',
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${tool} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * JSON with two-space indentation and short arrays of scalars on one line, which is how Biome formats JSON,
 * so a rebuilt catalog.json passes `pnpm lint` unchanged.
 */
export function formatJson(value: unknown): string {
  // An array whose elements each sit on one line; nested arrays collapse innermost first.
  const multiline = /\[\n\s+([^{}\n]*(?:,\n\s*[^{}\n]*)*)\n\s*\]/g;
  const collapse = (block: string, body: string, offset: number, whole: string) => {
    const inline = `[${body.split(/,\n\s*/).join(', ')}]`;
    const lineStart = whole.lastIndexOf('\n', offset) + 1;
    const width = offset - lineStart + inline.length + (whole[offset + block.length] === ',' ? 1 : 0);
    return width <= 110 ? inline : block;
  };
  let text = JSON.stringify(value, null, 2);
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(multiline, collapse);
  }
  return `${text}\n`;
}
