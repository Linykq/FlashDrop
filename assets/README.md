# Seed media

Demo content for FlashDrop: a small product catalog with photography, and the sample stream the live room plays
(`apps/web/public/hls/`). Two hand-edited files are the sources, `catalog/catalog.json` and `storyboard.json`;
the scripts in `pipeline/` build everything else from them.

## `catalog/`

One folder per product (`<slug>/1.jpg`, `2.jpg`, ...) plus:

- **`catalog.json`**, the seed catalog.
  - `taxonomy` is the fixed category list (the `category` enum of `ListingWire`, §10 of the design) with the
    attributes each category requires.
  - Each product has the `ListingWire` fields a listing keeps (`uncertainties` belongs to a model run, not to a
    product): `slug`, `title`, `description`, `category`, `condition`, `attributes` (`brand`, `color`,
    `material`, `size`), `highlights` and `tags`, plus a `suggestedPriceCents` in the top-level `currency` and
    its `images`. The copy follows the `ListingDraft` rules: title 10–80 characters, description 80–1,200,
    3–6 highlights of at most 120 characters, at most 10 tags, the attributes its category requires, and no
    prices, currency or claims such as "authentic" or "guaranteed". `brand` is always `null`: the products are
    unbranded.
  - Each image has its path relative to `catalog/` (`src`), pixel `width` and `height`, `alt` text, the backdrop
    `color` to show while it loads, and its `credit` (photographer, profile, Pexels page, licence). An optional
    `edit` records how the file was made from the original: a `crop`, and `retouch` regions (both
    `[left, top, width, height]` as fractions of the image). The build writes `width`, `height` and `color`.
- **`CREDITS.md`**: photographer, source page and licence of every image (generated).

All photos come from [Pexels](https://www.pexels.com) under the [Pexels License](https://www.pexels.com/license/);
each licence was read from the photo's own Pexels page when it was chosen. Each file was auto-oriented, cropped or
retouched where its `edit` says, resized to a 2,000 px long edge and encoded once from the original as a
progressive sRGB JPEG (mozjpeg, quality 82) with no metadata. No file is larger than 450 KB.

## `storyboard.json` and `apps/web/public/hls/`

A 48-second HLS VOD loop: one photo of each product, in catalog order, with slow pans and push-ins joined by soft
dissolves. The last frame leads straight back into the first, so it loops cleanly with the `loop` attribute.
`storyboard.json` holds the frame size and timing, and for each shot its catalog image, its camera move (`from` and
`to`: zoom, and the centre as fractions of the image) and the host's caption.

| File | Contents |
| --- | --- |
| `live.m3u8`, `init.mp4`, `live-000.m4s` ... `live-011.m4s` | H.264 High@4.0, 1280×720, 30 fps, BT.709, 2 s closed GOPs, in 4 s fragmented-MP4 segments that each start on an IDR frame, plus a silent 48 kHz stereo AAC-LC track for players that expect audio. hls.js and Safari's native HLS both play fMP4; unlike MPEG-TS segments, nothing ends in `.ts`, which TypeScript tooling would try to parse. |
| `poster.jpg` | The exact first frame. |
| `captions.en.vtt` | Host narration, one cue per shot. Each cue id is the product `slug`, so the UI can tell which product is on screen. |

The camera moves are rendered frame by frame at sub-pixel positions with a separable Mitchell filter (ffmpeg's
`zoompan` crops whole pixels, so slow pans judder), and the dissolves are blended in linear light. ffmpeg only
encodes: x264 `veryslow`, CRF 21, capped at 1.6 Mbit/s.

## `pipeline/`

| Script | Does |
| --- | --- |
| `build-catalog.ts` | Downloads each original from Pexels (once), applies its `edit`, encodes the JPEGs, refreshes the derived fields of `catalog.json`, regenerates `CREDITS.md` and deletes photos the catalog no longer lists. |
| `build-video.ts` | Renders the storyboard from the catalog photos and writes the playlist, segments, poster and captions. About 2.5 minutes. |
| `verify.ts` | Checks the listing rules, every JPEG (format, metadata, size, credit), the stream (codecs, duration, a keyframe at every segment start, size) and the captions against the storyboard. |

`assets` is a workspace package (`@flashdrop/assets`), so the scripts run from the repo root with
`pnpm --filter @flashdrop/assets exec tsx pipeline/<script>.ts` (verification: `pnpm --filter @flashdrop/assets media:verify`)
and `pnpm typecheck` covers them. The build scripts also need Docker for ffmpeg, which runs in
`linuxserver/ffmpeg:9.0-cli-ls84`, pinned by digest in `media.ts`. Downloads and render intermediates go to
`$MEDIA_CACHE` (default: `flashdrop-media` in the system temp folder), never into the repo.

To change the demo, edit `catalog.json` or `storyboard.json`, run the build scripts, then `verify.ts`. A new photo
needs its Pexels page as `credit.source`, with the licence checked on that page.
