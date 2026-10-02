/**
 * Renders the live-room loop from assets/storyboard.json and the catalog photos, then packages it for
 * apps/web/public/hls: an HLS VOD with fMP4 segments (no `.ts` files that TypeScript tooling would try to
 * parse), a silent AAC track for players that expect audio, the first frame as the poster, and the host
 * narration as WebVTT with one cue per shot, its id the product slug.
 *
 * Camera moves are rendered here rather than with ffmpeg's zoompan, whose whole-pixel crop makes slow
 * pans step visibly: each frame is resampled at true sub-pixel positions with a separable Mitchell filter,
 * and dissolves are blended in linear light so they don't dip in brightness. ffmpeg (in the pinned
 * container) only encodes.
 */
import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  CACHE_DIR,
  CATALOG_DIR,
  container,
  HLS_DIR,
  loopSeconds,
  productOf,
  SEGMENT_SECONDS,
  type Shot,
  shotStep,
  storyboard,
} from './media';

const { width: W, height: H, fps: FPS, shotSeconds: SHOT, fadeSeconds: FADE, shots } = storyboard;
const FRAMES = Math.round(loopSeconds * FPS);
const GOP_FRAMES = 2 * FPS;
/** Raw frames go to disk in chunks: Docker Desktop's stdin pipe (~8 MB/s) is far too slow to stream them. */
const CHUNK_FRAMES = FPS * 5;
const WORK_DIR = join(CACHE_DIR, 'render');
/** Splits a command-line fragment into arguments (none of the ones below contain spaces). */
const argv = (line: string) => line.split(' ');
const COLOR_TAGS = argv('-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv');
// Recent ffmpeg takes colour metadata from the frames, so tag them as well as the stream.
const TAG_FRAMES = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';

// The pixel loops below index typed arrays only at positions that are in range by construction (tap
// indices are clamped when the tables are built), so their `?? 0` never fires; it only satisfies
// noUncheckedIndexedAccess.

interface Source {
  shot: Shot;
  data: Buffer;
  w: number;
  h: number;
  /** Output pixels per source pixel at zoom 1, when the image just covers the frame. */
  cover: number;
}

interface View {
  cx: number;
  cy: number;
  scale: number;
}

interface Taps {
  idx: Int32Array;
  wts: Float32Array;
  taps: number;
  lo: number;
  hi: number;
}

function mitchell(t: number): number {
  const x = Math.abs(t);
  if (x < 1) return (7 * x ** 3 - 12 * x ** 2 + 16 / 3) / 6;
  if (x < 2) return ((-7 / 3) * x ** 3 + 12 * x ** 2 - 20 * x + 32 / 3) / 6;
  return 0;
}

/** Filter taps for `n` output samples starting at source position `origin`, `step` source px apart. */
function axisTaps(n: number, len: number, origin: number, step: number): Taps {
  const widen = Math.max(1, step);
  const radius = 2 * widen;
  const taps = Math.ceil(radius) * 2 + 1;
  const idx = new Int32Array(n * taps);
  const wts = new Float32Array(n * taps);
  let lo = len;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const center = origin + (i + 0.5) * step - 0.5;
    const first = Math.floor(center - radius) + 1;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const s = Math.min(len - 1, Math.max(0, first + k));
      const w = mitchell((first + k - center) / widen);
      idx[i * taps + k] = s;
      wts[i * taps + k] = w;
      sum += w;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    for (let k = 0; k < taps; k++) wts[i * taps + k] = (wts[i * taps + k] ?? 0) / sum;
  }
  return { idx, wts, taps, lo, hi };
}

/** Resamples the view of `img` into `out` (float RGB, W × H), using `tmp` for the horizontal pass. */
function renderView(img: Source, view: View, out: Float32Array, tmp: Float32Array): void {
  const step = 1 / view.scale;
  const xs = axisTaps(W, img.w, view.cx - (W / 2) * step, step);
  const ys = axisTaps(H, img.h, view.cy - (H / 2) * step, step);
  const src = img.data;
  const stride = W * 3;
  for (let r = 0; r <= ys.hi - ys.lo; r++) {
    const srow = (ys.lo + r) * img.w * 3;
    for (let i = 0; i < W; i++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let k = 0; k < xs.taps; k++) {
        const p = srow + (xs.idx[i * xs.taps + k] ?? 0) * 3;
        const w = xs.wts[i * xs.taps + k] ?? 0;
        red += (src[p] ?? 0) * w;
        green += (src[p + 1] ?? 0) * w;
        blue += (src[p + 2] ?? 0) * w;
      }
      tmp[r * stride + i * 3] = red;
      tmp[r * stride + i * 3 + 1] = green;
      tmp[r * stride + i * 3 + 2] = blue;
    }
  }
  for (let j = 0; j < H; j++) {
    const row = out.subarray(j * stride, (j + 1) * stride);
    row.fill(0);
    for (let k = 0; k < ys.taps; k++) {
      const from = ((ys.idx[j * ys.taps + k] ?? 0) - ys.lo) * stride;
      const w = ys.wts[j * ys.taps + k] ?? 0;
      for (let i = 0; i < stride; i++) row[i] = (row[i] ?? 0) + (tmp[from + i] ?? 0) * w;
    }
  }
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (l: number) => (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
/** sRGB (0–255, sixteenth steps) → linear, and linear (0–1, 8,192 steps) → sRGB 0–255. */
const TO_LINEAR = Float32Array.from({ length: 255 * 16 + 1 }, (_, i) => srgbToLinear(i / 16 / 255));
const FROM_LINEAR = Float32Array.from({ length: 8193 }, (_, i) => linearToSrgb(i / 8192) * 255);
const clamp255 = (x: number) => (x <= 0 ? 0 : x >= 255 ? 255 : x);
const linear = (x: number) => TO_LINEAR[Math.round(clamp255(x) * 16)] ?? 0;

/** Blends `b` into `a` in linear light, `wa` being the weight of `a`. */
function dissolve(a: Float32Array, b: Float32Array, wa: number): void {
  for (let i = 0; i < a.length; i++) {
    const l = linear(a[i] ?? 0) * wa + linear(b[i] ?? 0) * (1 - wa);
    a[i] = FROM_LINEAR[Math.round(l * 8192)] ?? 0;
  }
}

function quantize(frame: Float32Array, out: Buffer): void {
  for (let i = 0; i < frame.length; i++) out[i] = Math.round(clamp255(frame[i] ?? 0));
}

async function load(shot: Shot): Promise<Source> {
  const { data: pixels, info } = await sharp(join(CATALOG_DIR, shot.image))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pad = Math.round((shot.widen ?? 0) * info.width);
  const width = info.width + 2 * pad;
  const widened = await sharp(pixels, { raw: { width: info.width, height: info.height, channels: 3 } })
    .extend({ left: pad, right: pad, extendWith: 'mirror' })
    .raw()
    .toBuffer();
  // Shrink up front so that even the tightest zoom downsamples a little; never upscale.
  const zoom = Math.max(shot.from.zoom, shot.to.zoom);
  const fit = Math.min(1, (Math.max(W / width, H / info.height) * zoom) / 0.85);
  const w = Math.round(width * fit);
  const h = Math.round(info.height * fit);
  const data = await sharp(widened, { raw: { width, height: info.height, channels: 3 } })
    .resize(w, h, { kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  return { shot, data, w, h, cover: Math.max(W / w, H / h) };
}

/** Eases in and out of the move, so a shot never starts or stops with a jolt. */
const ease = (s: number) => s - Math.sin(2 * Math.PI * s) / (2 * Math.PI);
const smoothstep = (s: number) => s * s * (3 - 2 * s);
const lerp = (a: number, b: number, s: number) => a + (b - a) * s;

function viewAt(img: Source, tau: number): View {
  const s = ease(Math.min(1, Math.max(0, tau / SHOT)));
  const { from, to } = img.shot;
  const scale = img.cover * from.zoom * (to.zoom / from.zoom) ** s;
  const halfW = W / 2 / scale;
  const halfH = H / 2 / scale;
  return {
    cx: Math.min(img.w - halfW, Math.max(halfW, lerp(from.x, to.x, s) * img.w)),
    cy: Math.min(img.h - halfH, Math.max(halfH, lerp(from.y, to.y, s) * img.h)),
    scale,
  };
}

/**
 * The shots visible at time t, with their weights. t = 0 is the moment shot 0 has fully faded in, and the
 * last shot dissolves into a second copy of shot 0, so frame FRAMES would equal frame 0: the loop is seamless.
 */
function activeAt(sources: readonly Source[], t: number) {
  const active = [];
  for (let s = 0; s <= sources.length; s++) {
    const tau = t - (s * shotStep - FADE);
    if (tau < 0 || tau >= SHOT) continue;
    const weight =
      tau < FADE ? smoothstep(tau / FADE) : tau > SHOT - FADE ? smoothstep((SHOT - tau) / FADE) : 1;
    const img = sources[s % sources.length];
    if (img && weight > 0) active.push({ img, tau, weight });
  }
  return active;
}

const chunkName = (k: number) => `chunk-${String(k).padStart(3, '0')}`;

/** Encodes one chunk of raw frames to a near-lossless mezzanine, then drops the raw file. */
async function encodeChunk(k: number): Promise<void> {
  await container(
    'ffmpeg',
    [
      ...argv(`-f rawvideo -pix_fmt rgb24 -s ${W}x${H} -r ${FPS} -i /work/${chunkName(k)}.rgb`),
      '-vf',
      `scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,${TAG_FRAMES}`,
      ...argv('-c:v libx264 -preset medium -crf 4'),
      ...COLOR_TAGS,
      `/work/${chunkName(k)}.mp4`,
    ],
    { '/work': WORK_DIR },
  );
  await rm(join(WORK_DIR, `${chunkName(k)}.rgb`));
}

async function render(): Promise<Buffer> {
  const sources = await Promise.all(shots.map(load));
  const frameA = new Float32Array(W * H * 3);
  const frameB = new Float32Array(W * H * 3);
  const tmp = new Float32Array(Math.max(...sources.map((s) => s.h)) * W * 3);
  const out = Buffer.alloc(W * H * 3);
  const chunks = Math.ceil(FRAMES / CHUNK_FRAMES);
  const encodes: Promise<void>[] = [];
  let poster: Buffer | undefined;
  for (let k = 0; k < chunks; k++) {
    const file = await open(join(WORK_DIR, `${chunkName(k)}.rgb`), 'w');
    for (let f = k * CHUNK_FRAMES; f < Math.min(FRAMES, (k + 1) * CHUNK_FRAMES); f++) {
      const [a, b] = activeAt(sources, f / FPS);
      if (!a) throw new Error(`No shot on screen at frame ${f}`);
      renderView(a.img, viewAt(a.img, a.tau), frameA, tmp);
      if (b) {
        renderView(b.img, viewAt(b.img, b.tau), frameB, tmp);
        dissolve(frameA, frameB, a.weight / (a.weight + b.weight));
      }
      quantize(frameA, out);
      if (f === 0) poster = Buffer.from(out);
      await file.write(out);
    }
    await file.close();
    encodes.push(encodeChunk(k));
    console.log(`rendered ${Math.min(FRAMES, (k + 1) * CHUNK_FRAMES)}/${FRAMES} frames`);
  }
  await Promise.all(encodes);
  await writeFile(
    join(WORK_DIR, 'chunks.txt'),
    Array.from({ length: chunks }, (_, k) => `file '${chunkName(k)}.mp4'\n`).join(''),
  );
  if (!poster) throw new Error('The loop has no frames');
  return poster;
}

async function packageHls(): Promise<void> {
  for (const file of await readdir(HLS_DIR)) {
    if (/^(live.*\.(m3u8|m4s|ts)|init\.mp4)$/.test(file)) await rm(join(HLS_DIR, file));
  }
  await container(
    'ffmpeg',
    [
      ...argv('-f concat -safe 0 -i /work/chunks.txt'),
      ...argv(`-f lavfi -t ${loopSeconds} -i anullsrc=channel_layout=stereo:sample_rate=48000`),
      ...argv('-map 0:v:0 -map 1:a:0 -vf'),
      TAG_FRAMES,
      ...argv('-c:v libx264 -preset veryslow -profile:v high -level:v 4.0 -pix_fmt yuv420p'),
      ...argv('-crf 21 -maxrate 1600k -bufsize 3200k'),
      ...COLOR_TAGS,
      // 2 s closed GOPs and no scene-cut keyframes, so every segment starts on an IDR frame.
      ...argv(`-g ${GOP_FRAMES} -keyint_min ${GOP_FRAMES} -sc_threshold 0 -x264-params aq-mode=3:open-gop=0`),
      ...argv(`-c:a aac -b:a 48k -ac 2 -ar 48000 -t ${loopSeconds}`),
      ...argv(`-f hls -hls_time ${SEGMENT_SECONDS} -hls_playlist_type vod -hls_flags independent_segments`),
      ...argv('-hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4'),
      ...argv('-hls_segment_filename /hls/live-%03d.m4s /hls/live.m3u8'),
    ],
    { '/work': WORK_DIR, '/hls': HLS_DIR },
  );
}

function timestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const hh = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
  const mm = String(Math.floor(ms / 60_000) % 60).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}.${String(ms % 1000).padStart(3, '0')}`;
}

/** One cue per shot, switching at the midpoint of each dissolve with a short gap either side. */
function captions(): string {
  const handover = (k: number) => k * shotStep + SHOT - 1.5 * FADE;
  const cues = shots.map((shot, k) => {
    const start = k === 0 ? 0 : handover(k - 1) + 0.2;
    return `${productOf(shot)}\n${timestamp(start)} --> ${timestamp(handover(k) - 0.2)}\n${shot.caption}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

await rm(WORK_DIR, { recursive: true, force: true });
await mkdir(WORK_DIR, { recursive: true });
await mkdir(HLS_DIR, { recursive: true });
const firstFrame = await render();
await packageHls();
await sharp(firstFrame, { raw: { width: W, height: H, channels: 3 } })
  .jpeg({ quality: 84, progressive: true, mozjpeg: true })
  .toFile(join(HLS_DIR, 'poster.jpg'));
await writeFile(join(HLS_DIR, 'captions.en.vtt'), captions());
await rm(WORK_DIR, { recursive: true });
console.log(`${loopSeconds} s loop, ${FRAMES} frames, ${shots.length} shots → ${HLS_DIR}`);
