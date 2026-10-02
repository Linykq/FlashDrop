# FlashDrop design system

*Version 1, 2026-10-02. Visual direction (owner decision, 2026-10-01/02): Apple-like and neutral, light-first with a full dark mode. Free-license stock photos (Unsplash License, Pexels License) are allowed when credited.*

*Audience: whoever builds `apps/web` (M1, M3, M5 to M8) and whoever reviews its UI. This document is the contract for both. A screen that contradicts it is a bug, either in the screen or in this document: fix one of them in the same PR.*

`docs/system-design.md` decides **what** the screens do: §7 real-time, §8 frontend, §9 dashboard, §10 listing generator, §11 security. This document decides **how they look, read, move and behave**. Where both cover a topic (live stock states in §8.2, the accessible checkout in §8.3), the system design wins and this document adds the visual and interaction detail. Section numbers written as "SD §8.3" refer to the system design.

Normative words: **must** blocks a review; **should** needs a reason in the PR description to deviate; **may** is optional. Every value here is exact. If an implementation needs a value that isn't here, add it here first.

"Apple-like" means Apple's principles applied to our own product, never Apple's assets. No Apple logos, product names, imagery or copy. SF Pro is used only where the operating system provides it (`-apple-system`) and is never self-hosted, because its license limits it to Apple platforms.

## Contents

1. [Principles](#1-principles)
2. [Colour](#2-colour)
3. [Typography](#3-typography)
4. [Layout](#4-layout)
5. [Shape, elevation and materials](#5-shape-elevation-and-materials)
6. [Motion](#6-motion)
7. [Icons](#7-icons)
8. [Implementation](#8-implementation)
9. [Components](#9-components)
10. [Page blueprints](#10-page-blueprints)
11. [Imagery](#11-imagery)
12. [Voice and microcopy](#12-voice-and-microcopy)
13. [Accessibility](#13-accessibility)
14. [Performance](#14-performance)
15. [UI review checklist](#15-ui-review-checklist)
- [Appendix A. Contrast proof](#appendix-a-contrast-proof)
- [Appendix B. Decisions and follow-ups](#appendix-b-decisions-and-follow-ups)

---

## 1. Principles

Each principle is turned into rules that a reviewer can check.

### 1.1 Clarity

The live number, the price and the one action are readable at a glance.

- One filled (primary) button per region: a page section, a card or a dialog. Every other action is tinted, gray or plain.
- The purchase action is reachable without scrolling at every width, either inline or through the sticky buy bar (§10.2).
- Text never sits directly on a photo or video. It sits on a material or a fill whose contrast is proven in Appendix A.
- Numbers that matter (price, stock, countdown) use tabular figures and are never truncated.

### 1.2 Deference

The product photo and the live video are the interface. Chrome recedes.

- Chrome uses neutral surfaces, labels and materials. Colour is reserved for the accent (interactive or in progress), live red (live state) and status.
- Navigation and toolbars are translucent materials over content, never solid colour bars.
- No decorative gradients, illustrations, background patterns, emoji, or text shadows.
- Product imagery is visible in the first viewport of `/` and `/p/[slug]` at 390 × 844 and at 1440 × 900: the gallery starts directly under the navigation bar, and the home hero photo starts above the fold.

### 1.3 Depth

Layers explain hierarchy: content, then bars, then floating surfaces, then modals.

- Four planes only: content (elevation 0 or 1), bars (`material-bar`), floating surfaces (elevation 2), modals (elevation 3 over a scrim).
- Motion follows the plane: dialogs scale from 0.96, sheets come from the edge they belong to, toasts rise 16 px.
- Dark mode shows depth with lighter surfaces (`#000000`, `#1c1c1e`, `#2c2c2e`) and 1 px light hairlines, not with shadows.

### 1.4 Restraint

- One accent hue, blue `#0071e3`. Live red appears only for live state. Green, orange and red status colours appear only in status pills, banners, field errors, the checkout hold, urgent stock (text and meter) and admin health.
- Three weights exist: 400, 500 and 600. A component uses at most two of them and at most three type sizes.
- Whitespace separates first, hairlines second, boxes third.

### 1.5 Content first

- Real data drives every number. "Only 12 left" is true at render time, the viewer count is the gateway's count (SD §7) and a countdown is a real deadline. No invented urgency, ever: "Only" appears only when stock is urgent (§9.9), so a drop with 488 left says "488 left".
- Copy is specific: "Only 12 left", never "Selling fast" (§12).
- In admin, a stat tile beats a chart when one number answers the question.

### 1.6 Calm under pressure

A flash sale is stressful, so the interface is the calm part.

- Checkout has one column, no promotion, no navigation except "Leave checkout", and switches to the warning colour only in the last 60 seconds (§10.4).
- Nothing blinks except the LIVE dot of the hero, the live room and the navigation bar. It pulses three times (4.8 s), then rests, and doesn't pulse at all under reduced motion.
- Errors say what happened and what to do next. They never blame and never apologise at length (§12).

---

## 2. Colour

### 2.1 Model

- Components use **semantic tokens only** (`bg-surface`, `text-label-secondary`, `bg-accent`). No hex values in components, and no Tailwind default palette: `@theme` removes it (§8.2), so `bg-white` or `text-gray-500` generate nothing.
- Every token has a light and a dark value. The dark values are swapped in by the theme (§8.3), never by `dark:` utilities in components.
- Values marked "same" do not change between modes.

### 2.2 Surfaces and fills

| Token (`--color-*`) | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#ffffff` | `#000000` | Page background of plain pages: home, product, live room |
| `bg-secondary` | `#f5f5f7` | `#1c1c1e` | Alternating full-bleed sections, image wells, footer |
| `canvas` | `#f5f5f7` | `#000000` | Background of grouped pages: checkout, order, login, admin |
| `surface` | `#ffffff` | `#1c1c1e` | Cards on `canvas`, text fields, dialogs |
| `surface-raised` | `#ffffff` | `#2c2c2e` | Solid fallback of `material-thick` (toasts, tooltips). Never holds form fields |
| `fill` | `rgb(120 120 128 / 0.20)` | `rgb(120 120 128 / 0.36)` | Pressed state of gray buttons |
| `fill-secondary` | `rgb(120 120 128 / 0.16)` | `rgb(120 120 128 / 0.32)` | Hover of gray buttons, stock meter track |
| `fill-tertiary` | `rgb(118 118 128 / 0.12)` | `rgb(118 118 128 / 0.24)` | Gray buttons, segmented control track, neutral pills, stepper |
| `fill-quaternary` | `rgb(116 116 128 / 0.08)` | `rgb(118 118 128 / 0.18)` | Skeletons, plain-button hover, read-only fields |
| `thumb` | `#ffffff` | `#636366` | Segmented control thumb |
| `scrim` | `rgb(0 0 0 / 0.40)` | `rgb(0 0 0 / 0.60)` | Dialog backdrop |

`bg-secondary` and `canvas` are the same in light mode and differ in dark mode on purpose: a grouped page in dark mode is black with `#1c1c1e` cards, so cards still read as raised.

### 2.3 Labels and lines

| Token | Light | Dark | Use |
|---|---|---|---|
| `label` | `#1d1d1f` | `#f5f5f7` | Primary text and icons; the sold segment of the stock meter |
| `label-secondary` | `#6e6e73` | `#a1a1a6` | Supporting text, field labels, inactive tabs, meta. At least 4.5:1 on every surface |
| `label-tertiary` | `#86868b` | `#7c7c80` | **Not for readable text.** Disabled labels, decorative glyphs, chevrons, empty-state icons. At least 3:1 on every surface. The one exception is the label of a disabled control ("Sold out" on the Buy button), which WCAG 1.4.3 exempts as inactive; LiveStock always repeats that state in `label` |
| `label-on-color` | `#ffffff` | same | Text and icons on `accent` and `live` fills |
| `separator` | `#d2d2d7` | `#424245` | Decorative 1 px hairlines between rows and sections. Never a control boundary |
| `control` | `#86868b` | `#7c7c80` | Boundaries that identify a control: text field, select, radio, upload dropzone. At least 3:1 (WCAG 1.4.11) |

### 2.4 Accent, live and status

| Token | Light | Dark | Use |
|---|---|---|---|
| `accent` | `#0071e3` | same | Filled button, checked radio, progress fills |
| `accent-hover` | `#0066cc` | same | Filled button hover. Darker, not lighter, so white text keeps 4.5:1 |
| `accent-pressed` | `#005bb8` | same | Filled button pressed |
| `accent-label` | `#0060c0` | `#409cff` | Accent text and icons: links, plain and tinted buttons, info pills |
| `accent-tint` | `rgb(0 113 227 / 0.12)` | `rgb(64 156 255 / 0.14)` | Tinted button, info pills |
| `accent-tint-hover` | `rgb(0 113 227 / 0.16)` | `rgb(64 156 255 / 0.18)` | Tinted button hover and pressed, text selection |
| `live` | `#e0182d` | same | LIVE badge and live dot, nothing else |
| `success` | `#18732f` | `#30d158` | Text and icons: paid, approved, healthy |
| `success-tint` | `rgb(52 199 89 / 0.12)` | `rgb(48 209 88 / 0.16)` | Background of success pills and banners |
| `warning` | `#a34900` | `#ff9f0a` | Text and icons: needs review, paused, last 60 s of a hold |
| `warning-tint` | `rgb(255 149 0 / 0.12)` | `rgb(255 159 10 / 0.16)` | Background of warning pills, banners, uncertainty prompts |
| `danger` | `#c40013` | `#ff6961` | Text and icons: errors, declined, failing checks, destructive actions, urgent stock text and meter |
| `danger-tint` | `rgb(255 59 48 / 0.12)` | `rgb(255 69 58 / 0.16)` | Background of danger pills, banners and destructive tinted buttons |
| `danger-tint-hover` | `rgb(255 59 48 / 0.16)` | `rgb(255 69 58 / 0.20)` | Destructive tinted button hover and pressed |
| `focus` | `#0060c0` | `#409cff` | Focus ring. The light value equals `accent-label`, so the ring keeps 3:1 on `material-bar` over dark content. Inside `material-overlay` it becomes `#ffffff` |

The status base values are text-safe: each passes 4.5:1 on every surface **and** on its own tint (Appendix A). That is why the light values are darker than Apple's system colours.

### 2.5 Materials

| Material | Light background | Dark background | Filter | Solid fallback (light / dark) | Use |
|---|---|---|---|---|---|
| `material-bar` | `rgb(251 251 253 / 0.8)` | `rgb(22 22 23 / 0.8)` | `saturate(180%) blur(20px)` | `#fbfbfd` / `#161617` | Navigation bar, sticky buy bar, sheet footer, review action bar |
| `material-thick` | `rgb(255 255 255 / 0.86)` | `rgb(44 44 46 / 0.86)` | `saturate(180%) blur(30px)` | `surface-raised` (`#ffffff` / `#2c2c2e`) | Toasts, chart tooltips, gallery arrow buttons |
| `material-overlay` | `rgb(28 28 30 / 0.72)` | same | `saturate(160%) blur(24px)` | `rgb(28 28 30 / 0.92)` | Anything on video or photos: viewer-count pill, player control capsules, the docked drop card |

Rules:

- Every text and icon placed directly on `material-bar` or `material-thick` is `label`, including plain buttons and links (no accent; plain buttons take the neutral tone, §9.1). Over the worst content (black behind a light material, white behind a dark one) `label` keeps at least 8:1, while `label-secondary`, `accent-label` and the status colours drop as low as 3.06:1, so they **must not** be used there. The single exception is a toast's 20 px status icon, which keeps its tone colour as a non-text graphic (at least 3:1, Appendix A). Filled and gray buttons bring their own fill and keep their colours.
- `material-overlay` is always dark. The utility also sets `label` to white, `label-secondary` to white at 80% and `focus` to white for its subtree. Over a pure white video frame these keep 6.72:1 and 5.01:1. Text on it is white or white at 80%; accent and status text are not allowed on it. Filled buttons are.
- The solid fallback applies without `backdrop-filter` support and under `prefers-reduced-transparency: reduce`. In `forced-colors: active` the browser substitutes system colours; keep 1 px borders on bars so their shape survives.
- At most two blurred surfaces are visible at once (the navigation bar plus one). `material-overlay` elements inside the video player don't count toward this limit; together they cover at most 30% of the video (§14). Never animate a blur radius; animate the blurred element's opacity or transform.

### 2.6 Chart palette (admin)

| Token | Light | Dark |
|---|---|---|
| `chart-1` | `#0071e3` | `#2b8cf2` |
| `chart-2` | `#c95f00` | `#d97400` |
| `chart-3` | `#9a4fd6` | `#a35ee6` |
| `chart-4` | `#1a8a72` | `#1f9a80` |
| `chart-grid` | `#e8e8ed` | `#2c2c2e` |
| `chart-muted` | `#86868b` | `#7c7c80` |

Validated on 2026-10-02 in this order against `surface` in both modes: every slot is at least 3:1 against the surface, OKLCH lightness is inside the band (light 0.43 to 0.77, dark 0.48 to 0.67), chroma is at least 0.10, the worst adjacent-pair colour-vision-deficiency distance is ΔE 11.8 or more (OKLab ×100, target 8), and the worst normal-vision distance is ΔE 24 or more. Series *n* always gets `chart-n`; a fifth series folds into "Other" in `chart-muted`. Status colours are never used as series colours.

### 2.7 Rules

1. Colour is never the only signal. Status pills carry text and an icon, urgent stock carries text, chart series carry a legend or a direct label, errors carry an icon and text.
2. Accent marks what is interactive or in progress. Don't use it for emphasis; use weight.
3. Live red appears only on the LIVE badge and the live dot. Urgent stock and errors use `danger`; prices and promotions never use red.
4. Links inside running text are always underlined (`underline underline-offset-4 decoration-1`), because `accent-label` against `label` text is below 3:1. Standalone links (navigation, footer, "Watch the live drop" with its `ChevronRight`) need no underline.
5. Photos are never inverted or dimmed in dark mode.

---

## 3. Typography

### 3.1 Typefaces

**Sans:** `-apple-system, BlinkMacSystemFont, var(--font-inter), system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`

- On Apple platforms the first two names resolve to SF Pro. The system switches between SF Pro Text and SF Pro Display at 20 pt by itself, and those devices never download Inter.
- Everywhere else (Windows, Android, Linux) the stack resolves to **Inter 4**, self-hosted: the Latin subset `inter-latin-opsz-normal.woff2` (72.9 KB) from `@fontsource-variable/inter` 5.3.0, OFL-1.1, with a `wght` axis (100 to 900) and an optical-size axis `opsz` (14 to 32). `font-optical-sizing: auto` (the default) uses Inter Display at 32 px and above, which is what makes large titles look right on Windows.
- `system-ui` is deliberately not first. It resolves to Segoe UI on Windows and Roboto on Android, which would make three different products.
- The subset has the OpenType features `calt`, `ccmp`, `dnom`, `frac`, `locl`, `numr`, `pnum` and `tnum` (checked 2026-10-02). It has no stylistic sets, so `ss0x` and `cv0x` are not used.

**Mono:** `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`. Admin only, for ids (order, event, job) and technical values.

### 3.2 Type scale

Sizes are px, written as size/line-height. Phone is below 735 px, tablet 735 to 1068 px, desktop 1069 px and up. One class sets size, line height, weight and tracking; the responsive steps come from variables (§8.2), so `text-title-1` alone is responsive.

| Style | Class | Phone | Tablet | Desktop | Weight | Tracking, Inter | Tracking, SF Pro (phone / tablet / desktop) | Use |
|---|---|---|---|---|---|---|---|---|
| Display 1 | `text-display-1` | 48/52 | 64/68 | 80/84 | 600 | −0.016em | −0.003 / −0.009 / −0.015em | Home hero headline of up to 24 characters (§10.1). One per page |
| Display 2 | `text-display-2` | 40/44 | 48/52 | 56/60 | 600 | −0.014em | 0 / −0.003 / −0.005em | Order status headline, home empty-state hero, hero headlines of 25 to 40 characters |
| Title 1 | `text-title-1` | 28/32 | 32/36 | 40/44 | 600 | −0.012em | 0.007 / 0.004 / 0em | Page `h1`: product name, Checkout, admin page titles, not-found and error pages; home section headings; longer hero headlines |
| Title 2 | `text-title-2` | 24/28 | 24/28 | 28/32 | 600 | −0.010em | 0.009 / 0.009 / 0.007em | Card group headings, sheet titles, product price, checkout countdown |
| Title 3 | `text-title-3` | 20/24 | 20/24 | 20/24 | 600 | −0.008em | 0.012em | Tile titles, fieldset legends, alert titles, empty-state titles |
| Headline | `text-headline` | 17/22 | 17/22 | 17/22 | 600 | −0.016em | −0.022em | Emphasised body: stock text, row titles, totals, navigation wordmark |
| Intro | `text-intro` | 19/27 | 21/29 | 21/29 | 400 | −0.008em | 0.012 / 0.011 / 0.011em | Lead paragraph under a display or title |
| Body | `text-body` | 17/25 | 17/25 | 17/25 | 400 | −0.016em | −0.022em | Default text, input values, descriptions, lg button labels (500) |
| Callout | `text-callout` | 15/20 | 15/20 | 15/20 | 400; 500 in controls | −0.008em | −0.016em | md button labels, table cells, tabs, banner text |
| Footnote | `text-footnote` | 13/18 | 13/18 | 13/18 | 400; 500 in controls | −0.003em | same as Inter | Meta, helper and error text, sm buttons, table headers, footer, nav links |
| Caption | `text-caption` | 12/16 | 12/16 | 12/16 | 400 to 600 | 0 | same as Inter | Pills, badges, chart ticks, raised field labels. **Smallest text allowed** |

Rules:

- Only these eleven styles exist. Tailwind's default `text-*`, `leading-*` and `tracking-*` scales are removed, and arbitrary values (`text-[15px]`) are not allowed. The single exception is the LIVE badge's `tracking-[0.04em]` with `uppercase`.
- Each style sets its own weight (400 or 600), so a `text-*` class alone gives the weight in the Weight column; `font-medium` or `font-semibold` changes it where the table allows. `<b>` and `<strong>` render at 600, never 700.
- Headings use `text-wrap: balance` and paragraphs use `text-wrap: pretty` (base CSS).
- Running text is at most 680 px wide (`max-w-text`), about 70 characters at 17 px.
- Titles clamp at two lines (`line-clamp-2`) in tiles and table cells. Numbers, prices, statuses and error text are never truncated.
- Uppercase appears only in the LIVE badge, and only through CSS (the DOM text stays "Live").
- **Two tracking columns.** SF Pro and Inter need different tracking: apple.com sets SF Pro slightly open from 19 to 32 px, where Inter needs negative values. The Inter column is the default. The SF Pro column comes from apple.com's type scale and applies on Apple platforms, where the stack always resolves to SF Pro: the pre-paint script marks them with `data-font="sf"` on `<html>` (§8.3), and `base.css` swaps the values (§8.2).
- **Tracking check (M1).** M1 compares every style on Windows Chrome (Inter) and on macOS and iOS Safari (SF Pro) against the matching apple.com style, may adjust any value by up to ±0.02em, and updates this table.

### 3.3 Numerals and formats

- `tabular-nums` **must** be on prices, stock counts, countdowns, viewer counts, quantities, numeric table columns, chart ticks and dashboard tiles. All of these either update in place or align in columns, so proportional digits would jitter.
- All formatting goes through `apps/web/lib/format.ts`, which uses `Intl` only:

| Kind | Rule | Examples |
|---|---|---|
| Money | `Intl.NumberFormat(locale, { style: 'currency', currency })` from integer cents. Storefront surfaces (tiles, product, live) drop `.00`; checkout, order and admin always show cents, except stat tiles: from $10,000 they show the value compact (`notation: 'compact'`, one decimal) and the exact amount in the tile's sub-line | `$129`, `$129.50`, `$258.00`, `$62.2K` with "$62,178.00 gross" |
| Counts | Grouping separators. Dashboard tiles compact at 10,000 and above | `1,284`, `12.9K` |
| Countdown | Only for deadlines under 24 hours: `h:mm:ss` from one hour up, `m:ss` below, never negative. A deadline 24 hours or more away is an absolute time instead ("Starts Tue, Oct 6 at 7:00 PM") | `2:14:09`, `4:09`, `0:09` |
| Duration | Whole units in words | `2 minutes`, `90 seconds`, `4m 12s` (admin) |
| Absolute time | `Intl.DateTimeFormat` in the viewer's time zone | `Today at 7:00 PM`, `Tue, Oct 6 at 7:00 PM` |
| Plurals | `Intl.PluralRules` | `1 in a cart`, `3 in carts` |

- Absolute times render through `<LocalTime iso>`: a `<time dateTime>` whose text comes from `useSyncExternalStore`. The server snapshot is formatted in UTC with the zone name, and the client snapshot in the viewer's zone, so hydration never mismatches. Wherever possible a zone-free countdown is the primary text and the absolute time is secondary.
- Countdowns use server-corrected time: SSR passes `serverNow`, and live pages correct with `hello.serverTime` (SD §8.1). They never use the bare client clock.

### 3.4 Font loading

```ts
// apps/web/app/fonts.ts
import localFont from 'next/font/local';

export const inter = localFont({
  src: './fonts/InterVariable.woff2', // inter-latin-opsz-normal.woff2 from @fontsource-variable/inter 5.3.0 (OFL-1.1)
  variable: '--font-inter',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: 'Arial',
});
```

- The file is vendored at `apps/web/app/fonts/InterVariable.woff2` with its license at `apps/web/app/fonts/OFL.txt`. It is not loaded with `next/font/google`, which needs the network at build time.
- `preload: false` keeps Apple devices from downloading a font they never use. A browser fetches a web font only when the stack reaches it.
- `adjustFontFallback: 'Arial'` generates a metric-matched fallback, so the swap to Inter moves nothing on the page.
- `inter.variable` **must** be on `<html>`. `--font-sans` is resolved on the root element, which must define `--font-inter`.
- No other web fonts and no icon fonts.

---

## 4. Layout

### 4.1 Spacing

- The base unit is 4 px (Tailwind's `--spacing: 0.25rem`, unchanged). These rules cover padding, margin and gap; component dimensions (heights, thumbnail sizes) are set per component in §9.
- Allowed steps (Tailwind number = px): `0.5` = 2, `1` = 4, `1.5` = 6, `2` = 8, `2.5` = 10, `3` = 12, `4` = 16, `5` = 20, `6` = 24, `7` = 28, `8` = 32, `10` = 40, `12` = 48, `14` = 56, `16` = 64, `20` = 80, `24` = 96, `28` = 112. No other steps and no arbitrary values.
- 2, 6 and 10 px are for component internals only: 2 px for hairline gaps (segmented control inset, stock meter segments), 6 px for icon-to-text gaps and small badge padding, 10 px for pill padding. Between blocks, prefer multiples of 8; the semantic variables below are the fixed exceptions.

Semantic variables (set in `base.css`, used as `gap-(--grid-gap)`, `py-(--section-space)`):

| Variable | Phone | Tablet | Desktop | Use |
|---|---|---|---|---|
| `--page-margin` | 20 | 32 | 40 | Minimum distance from the viewport edge to content |
| `--grid-gap` | 16 | 20 | 24 | Column gap and tile gap |
| `--section-space` | 64 | 80 | 112 | Vertical padding of a page section |
| `--nav-height` | 48 | 48 | 48 | Navigation bar height, plus `env(safe-area-inset-top)` |

Rhythm inside a section:

| Between | Phone | Tablet and up |
|---|---|---|
| Section heading and its content | 24 | 32 |
| Paragraphs | 16 | 16 |
| Field and field | 16 | 16 |
| Fieldset and fieldset | 40 | 40 |
| Card padding (storefront, checkout) | 20 | 24 |
| Card padding (dense admin) | 16 | 20 |
| Stacked cards | 16 | 24 |

### 4.2 Breakpoints

Apple's own breakpoints, mobile-first. Tailwind's default names are redefined and `xl`/`2xl` don't exist.

| Name | Min width | Prefix | Grid |
|---|---|---|---|
| Phone | 0 | none | 4 columns |
| Tablet | 735 px | `sm:` | 8 columns |
| Desktop | 1069 px | `md:` | 12 columns |
| Wide | 1441 px | `lg:` | 12 columns; content stays at its max width and only the margins grow |

Every page is checked at 320 (the reflow minimum), 390, 768, 1024, 1280, 1440 and 1920 px wide.

### 4.3 Containers

`page-*` utilities set `width: min(100% - 2 × (--page-margin + --safe-x), <max>)` and centre the block. `--safe-x` is the larger horizontal safe-area inset (§4.5), so it is 0 everywhere except a notched phone in landscape. Full-bleed backgrounds sit on the section; the container goes inside it.

| Utility | Max width | Use |
|---|---|---|
| `page-form` | 600 px | Checkout, order status, login |
| `page-text` | 680 px | Long-form text |
| `page-content` | 980 px | Product details section, footer |
| `page-wide` | 1200 px | Home hero and tiles, product page top, live room |
| `page-full` | 1440 px | Admin |

### 4.4 Grid

- Page-level layouts use `grid grid-cols-4 sm:grid-cols-8 md:grid-cols-12 gap-(--grid-gap)`. Components inside use flex or grid freely.
- Standard splits at desktop: product page 7 + 5 (gallery + panel), live room 8 + 4 (player + drop card), dashboard 8 + 4 (time series + stock now), listing review 5 + 7 (photos + form). Checkout is always one column.
- Admin at desktop: sidebar 240 px plus `minmax(0, 1fr)`.
- Tiles: 1 column on phone, 2 on tablet, 3 on desktop inside `page-wide` (384 px tiles at full width).

### 4.5 Safe areas, sticky elements and z-index

- The viewport uses `viewport-fit=cover`. The navigation bar pads `env(safe-area-inset-top)` and sticky bottom bars pad `env(safe-area-inset-bottom)`. `:root` sets `--safe-x: max(env(safe-area-inset-left), env(safe-area-inset-right))`, which the `page-*` containers add to the page margin on both sides, so content in landscape clears the sensor housing and stays centred.
- A focused element is never hidden behind a sticky bar (WCAG 2.4.11). `:root` sets `scroll-padding-block` to the navigation height + 16 px at the top and to `--bottom-bar-height` + 16 px at the bottom. A page with a sticky bottom bar marks it `data-bottom-bar`, which sets `--bottom-bar-height: 72px`.
- Native `<dialog>` (modal) and `popover` render in the browser's top layer and need no z-index. Everything else uses these variables:

| Variable | Value | Use |
|---|---|---|
| `--z-raised` | 10 | A hovered tile lifting over its neighbours |
| `--z-sticky` | 20 | Sticky buy bar, sticky table header, sticky purchase panel, review action bar |
| `--z-nav` | 30 | Navigation bar |
| `--z-toast` | 40 | Toast region |
| `--z-skip-link` | 50 | Skip link while focused |

---

## 5. Shape, elevation and materials

### 5.1 Radii

| Utility | px | Use |
|---|---|---|
| `rounded-xs` | 4 | LIVE badge, chart bar ends |
| `rounded-sm` | 8 | Thumbnails up to 64 px, skeleton blocks |
| `rounded-md` | 12 | Text fields, selects, radio cards, banners, uncertainty prompts, sidebar items, upload thumbnails |
| `rounded-lg` | 18 | Cards, product image wells, drop card, toasts, stat tiles |
| `rounded-xl` | 28 | Dialogs and sheets, hero media, the player at tablet width and up, login card |
| `rounded-full` | pill | Buttons, segmented control, stepper, status pills, chips, progress bars, avatars, viewer count, player control capsules |

Inner corners must be concentric: media inside a card is either flush and clipped by the card (`overflow-clip`), or uses `rounded-[calc(var(--radius-lg)-<inset>)]`. This is the only allowed arbitrary radius. Clipping uses `overflow-clip`, not `overflow-hidden`: it clips to the rounded corners without creating a scroll container, so `position: sticky` inside still works.

### 5.2 Elevation

Tailwind's `shadow-*` scale is removed. Use `elevation-*`, which reads a variable and so swaps in dark mode (Tailwind's own shadow utilities inline their values and would not).

| Level | Utility | Light | Dark | Use |
|---|---|---|---|---|
| 0 | none | none | none | Content on its surface; tiles at rest |
| 1 | `elevation-1` | `0 1px 2px rgb(0 0 0 / .04), 0 4px 16px rgb(0 0 0 / .06)` | `0 0 0 1px rgb(255 255 255 / .06)` | Cards on `canvas`, stat tiles, drop card |
| 2 | `elevation-2` | `0 2px 6px rgb(0 0 0 / .04), 0 12px 32px rgb(0 0 0 / .10)` | `0 0 0 1px rgb(255 255 255 / .08), 0 12px 32px rgb(0 0 0 / .5)` | Hovered tile image well, toast, tooltip, docked drop card |
| 3 | `elevation-3` | `0 4px 12px rgb(0 0 0 / .06), 0 24px 64px rgb(0 0 0 / .18)` | `0 0 0 1px rgb(255 255 255 / .08), 0 24px 64px rgb(0 0 0 / .6)` | Dialogs, sheets |
| Thumb | `elevation-thumb` | `0 3px 8px rgb(0 0 0 / .12), 0 3px 1px rgb(0 0 0 / .04)` | `0 3px 8px rgb(0 0 0 / .24)` | Segmented control thumb |

Don't put `elevation-*` and `ring-*` on the same element; both write `box-shadow`. Cards have no border in light mode; their hairline in dark mode comes from the elevation value.

### 5.3 Materials

Values and rules are in §2.5. Utilities: `material-bar`, `material-thick`, `material-overlay` (§8.2). A material is always the background of a component that floats over scrolling or moving content. Static content never uses a material.

---

## 6. Motion

### 6.1 Rules

- Motion explains a change of state: where something came from and where it went. It never decorates.
- Animate `transform` and `opacity`. Hover feedback may also transition `background-color`, `color` and `box-shadow`, for at most 300 ms. The one layout-property exception is the stock meter's segment widths: the element is 4 to 12 px tall and isolated, so the cost is negligible.
- Anything a user can interrupt (segmented thumb, sheets, toasts) uses a spring from `motion`. Hover and press use CSS transitions.
- Enter is slower than exit: an element that enters in 300 ms leaves in 200 ms.
- Infinite animations exist only for progress that has no end the user can see: the spinner and the indeterminate progress bar.

### 6.2 Durations and easing

| Duration | Utility | Use |
|---|---|---|
| 100 ms | `duration-100` | Press feedback release, colour changes inside controls |
| 200 ms | `duration-200` | Hover, small fades, every exit |
| 300 ms | `duration-300` | Enter of toasts, banners, dialogs; tile lift |

No other durations.

| Easing | Value | Use |
|---|---|---|
| `ease-standard` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Colour and opacity changes, hover |
| `ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entering elements, lifts, meter widths |
| `ease-in` | `cubic-bezier(0.7, 0, 0.84, 0)` | Exiting elements |
| `ease-sheet` | `cubic-bezier(0.32, 0.72, 0, 1)` | Dialog enter (CSS path) |

### 6.3 Springs

```ts
// apps/web/lib/motion.ts
import type { Transition } from 'motion/react';

export const spring = {
  snappy: { type: 'spring', visualDuration: 0.25, bounce: 0.1 },
  smooth: { type: 'spring', visualDuration: 0.4, bounce: 0 },
  celebrate: { type: 'spring', visualDuration: 0.5, bounce: 0.3 },
} as const satisfies Record<string, Transition>;
```

| Spring | Use |
|---|---|
| `snappy` | Segmented thumb, tab indicator, stepper value, stock number swap |
| `smooth` | Sheets, toast stack reflow, drop card docking, layout changes in the listing review |
| `celebrate` | Only two moments: the check mark when an order becomes PAID, and the "Reserved" confirmation in the Buy button |

No other springs. `visualDuration` is the time to visually reach the target, so springs line up with the duration table.

### 6.4 Catalogue

| Element | Enter / change | Exit | Notes |
|---|---|---|---|
| Button press | Pressed colour at once | Back to rest in 100 ms, `ease-standard` | Buttons never scale |
| Tile image well press (touch) | `scale-98`, 100 ms | 200 ms | `motion-safe:` only |
| Tile hover (pointer) | The image well gets `elevation-2` in 300 ms `ease-out`. The image never scales | 200 ms | `@media (hover: hover)` through Tailwind's `hover:` |
| Segmented thumb, tab indicator | Shared-layout move, `snappy` | n/a | `layoutId` |
| Toast | `translateY(16px)` → 0 with fade, `smooth` | Fade + `translateY(8px)`, 200 ms `ease-in` | Auto-dismiss after 5 s (§9.15) |
| Banner | Fade in, 200 ms | Fade out, 200 ms | Appears in a reserved slot, or as the result of the user's own action |
| Dialog, and a sheet from 735 px | Fade + `scale` 0.96 → 1, 300 ms `ease-sheet` (CSS `@starting-style`) | Fade + scale, 200 ms `ease-in` | Backdrop fades on the same timings |
| Sheet (below 735 px) | Panel `y: '100%'` → 0, `smooth`; backdrop fades in over 300 ms (CSS) | Panel to `y: '100%'`, 200 ms `ease-in`, with the backdrop fading out alongside; then `dialog.close()` | Drag to dismiss at velocity > 500 px/s or offset > 30% (§9.14) |
| Stock number | Old value fades out moving up 4 px, new value fades in from 4 px below, `snappy` | n/a | Skipped (plain swap) when updates arrive faster than 4 per second |
| Stock meter | Segment widths, 300 ms `ease-out` | n/a | |
| LIVE dot (hero, live room, navigation bar) | Opacity 1 → 0.35 → 1 over 1.6 s, three times (4.8 s), `ease-standard`, then rests at 1 | n/a | `motion-safe:animate-live-pulse`. Badges on tiles and in drop cards never pulse |
| Countdown | Digits swap each second, no animation | n/a | The checkout hold bar steps once per second |
| Indeterminate progress | A 40% wide fill slides from −100% to 250% of its width, 1.2 s, `ease-standard`, infinite | n/a | `motion-safe:animate-indeterminate`; under reduced motion the bar isn't rendered (§9.27) |
| Skeleton → content | Content fades in, 200 ms | n/a | Skeletons themselves are still |
| Order becomes PAID | Status icon crossfade 200 ms; check mark scales 0.6 → 1, `celebrate` | n/a | |
| Images | None | None | Images appear when decoded; the well colour is the placeholder |
| Route change | None | None | No view transitions in v1 |

### 6.5 Reduced motion

Under `prefers-reduced-motion: reduce`:

- `<MotionConfig reducedMotion="user">` turns off transform and layout animations in `motion`; opacity still animates.
- Every CSS transition or animation that moves, scales or rotates is written with `motion-safe:`. Reviewers reject any that isn't.
- Specifically: the LIVE dot doesn't pulse, the stock number and meter change instantly (SD §8.3), the countdown bar steps without transition (SD §8.3), the indeterminate progress bar isn't rendered (its status text remains), dialogs only fade, and the phone sheet's panel appears and leaves without moving while its backdrop fades.
- `animate-spin` stays: the activity indicator is the only signal of progress.
- The Playwright `a11y.spec` also runs with `reducedMotion: 'reduce'` (SD §13).

---

## 7. Icons

- **`lucide-react` 1.49.0 only.** No other icon set, no copied SVGs, no icon fonts, no emoji as icons. (Lucide 1.x has no brand icons; link to GitHub with text and `ArrowUpRight`.)
- Defaults come from `<LucideProvider size={20} strokeWidth={1.75} absoluteStrokeWidth>` in the root providers. `absoluteStrokeWidth` keeps the stroke at the given pixel width at any size, which matches SF Symbols' regular weight next to 17 px text.

| Size | px | Stroke | Pairs with |
|---|---|---|---|
| xs | 14 | 1.5 | Caption text: pills, badges, viewer count |
| sm | 16 | 1.75 | Footnote and callout text, sm and md buttons, table rows, field errors |
| md | 20 | 1.75 | Body text, lg buttons, banners, toasts, sidebar (the default) |
| lg | 24 | 1.75 | Player controls |
| xl | 40 | 1.5 | Empty states; order status icon inside a 72 px tinted circle |

- Icon and text sit in `inline-flex items-center` with `gap-1.5` (6 px) at xs and sm, and `gap-2` (8 px) at md and up.
- Icons inherit `currentColor`. Decorative chevrons use `label-tertiary`.
- Decorative icons get `aria-hidden="true"` automatically (Lucide adds it when no `aria-*`, `role` or `title` prop is passed). Icon-only buttons put `aria-label` on the button, never on the icon.
- Link arrows are icons, never characters. A link that leaves the current area (another site, or the storefront from admin) ends with `ArrowUpRight` 14; a "go to" link inside the area ("Watch the live drop", "Open dashboard") ends with `ChevronRight` 14. Both sit in `inline-flex items-center gap-1` and take the link's colour. Copy never contains ↗, ›, → or ✓.

Canonical icons (one meaning, one glyph, everywhere):

| Meaning | Icon | Meaning | Icon |
|---|---|---|---|
| Viewers | `Eye` | Countdown, hold | `Timer` |
| Scheduled | `CalendarClock` | Queued | `Clock` |
| Success, paid, healthy, step done | `CircleCheck` | Error, declined, failed, page error | `CircleX` |
| Field error | `CircleAlert` | Confirmed, inside a button ("Reserved") | `Check` |
| Warning, needs review | `TriangleAlert` | Information | `Info` |
| Paused | `CirclePause` | Ended | `CircleStop` |
| Expired | `Hourglass` | Cancelled | `Ban` |
| Not reserved | `CircleMinus` | Processing, generating (static, in pills) | `CircleDashed` |
| Activity indicator | `LoaderCircle` with `animate-spin` | AI: generated fields and the listing generator | `Sparkles` |
| Edited by a person | `Pencil` | Upload photos | `ImageUp` |
| Remove photo | `Trash` | Close, remove chip | `X` |
| Page not found | `Link2Off` | Stream unavailable | `VideoOff` |
| Back | `ChevronLeft` | Next, disclosure | `ChevronRight` |
| Select chevron | `ChevronDown` | Increase, decrease | `Plus`, `Minus` |
| Sign out | `LogOut` | Copy | `Copy` |
| Appearance: auto, light, dark | `Monitor`, `Sun`, `Moon` | Updates paused, offline | `WifiOff` |
| Retry, rebuilding | `RotateCw` | External link | `ArrowUpRight` |
| Play, pause | `Play`, `Pause` | Sound off, sound on (shows the current state) | `VolumeX`, `Volume2` |
| Captions | `Captions` | Fullscreen | `Maximize` |
| Admin: drops | `Layers` | Admin: new listing | `Sparkles` |
| Admin: health | `HeartPulse` | Admin: dashboard | `LayoutDashboard` |

---

## 8. Implementation

### 8.1 Where things live

```
apps/web/
  app/
    globals.css          @import "tailwindcss" and the three style files, nothing else
    layout.tsx           <html lang="en" className={inter.variable} suppressHydrationWarning>, ThemeScript,
                         Providers. No navigation: each area's layout below brings its own chrome
    not-found.tsx        every 404 (§10.0); sits outside the areas, so it renders the store bar and footer itself
    fonts.ts             next/font/local (§3.4)
    fonts/               InterVariable.woff2, OFL.txt
    (store)/             route group: /, /p/[slug], /orders/[orderId], /login
      layout.tsx         navigation bar and footer. The order and login pages mark their root data-page="grouped"
      error.tsx          shared error state (§10.0)
    checkout/[orderId]/
      layout.tsx         reduced navigation bar (§9.18), no footer, data-page="grouped"
      error.tsx
    live/[slug]/
      layout.tsx         <div data-theme="dark" data-page="live">, its own navigation bar inside, no footer
      error.tsx
    admin/
      layout.tsx         navigation bar in page-full, sidebar (§10.7), no footer, data-page="grouped"
      error.tsx
  styles/
    tokens.css           dark variant, @theme (light values), dark overrides
    base.css             root variables, responsive type steps, element defaults, dialog motion
    utilities.css        page-*, elevation-*, material-*, skeleton
    tokens.test.ts       token parity and contrast test (§8.8)
  components/
    ui/                  primitives: button, icon-button, segmented-control, text-field, select-field,
                         radio-group, quantity-stepper, dialog, sheet, toast, banner, skeleton,
                         empty-state, status-pill, tabs, spinner, steps, progress, chip-input,
                         page-dots, key-value-list, announcer, providers, motion-features
    layout/              nav-bar, large-title, footer, admin-sidebar, skip-link, route-state
    commerce/            product-tile, product-gallery, price, stock-meter, live-stock, countdown,
                         live-badge, viewer-count, drop-card, buy-button, local-time, order-list
    live/                player (the 'use client' dynamic wrapper, §8.7), player-view, player-controls
    checkout/            hold-timer, error-summary, leave-dialog, payment-methods (SD §14)
    admin/               stat-tile, chart-frame (the 'use client' dynamic wrapper, §8.7), chart-view,
                         data-table, listing-review, upload-dropzone
    theme/               theme-script, theme-switcher
  lib/
    format.ts            money, counts, countdowns, durations, dates (§3.3)
    clock.ts             one shared 1 s clock for every countdown
    motion.ts            spring presets (§6.3)
    cx.ts                class joiner (§8.7)
```

There is no `packages/ui`. `apps/web` is the only app that renders UI (SD §14). Primitives move into a package only when a second consumer appears.

### 8.2 Tokens in Tailwind CSS 4

The four files below are normative: M1 copies them verbatim (without the path comment on the first line), and from then on the files are the source of truth and this section is updated in the same PR as any change. They were compiled with `tailwindcss` 4.3.3 and checked with Biome 2.5.15 (format and lint) on 2026-10-02.

Biome only parses Tailwind's at-rules (`@theme`, `@utility`, `@custom-variant`, `@variant`, `@slot`) when the root `biome.json` enables them; without this, `pnpm lint` fails on these files:

```json
{ "css": { "parser": { "tailwindDirectives": true } } }
```

```css
/* apps/web/app/globals.css */
@import "tailwindcss";
@import "../styles/tokens.css";
@import "../styles/base.css";
@import "../styles/utilities.css";
```

```css
/* apps/web/styles/tokens.css */
@custom-variant dark {
  &:where([data-theme="dark"], [data-theme="dark"] *) {
    @slot;
  }
  @media (prefers-color-scheme: dark) {
    &:where(:root:not([data-theme="light"]), :root:not([data-theme="light"]) *):not(
        :where([data-theme="light"], [data-theme="light"] *)
      ) {
      @slot;
    }
  }
}

@theme {
  --color-*: initial;
  --font-*: initial;
  --font-weight-*: initial;
  --text-*: initial;
  --tracking-*: initial;
  --leading-*: initial;
  --radius-*: initial;
  --shadow-*: initial;
  --inset-shadow-*: initial;
  --drop-shadow-*: initial;
  --blur-*: initial;
  --ease-*: initial;
  --animate-*: initial;
  --breakpoint-*: initial;
  --container-*: initial;

  /* Surfaces */
  --color-bg: #ffffff;
  --color-bg-secondary: #f5f5f7;
  --color-canvas: #f5f5f7;
  --color-surface: #ffffff;
  --color-surface-raised: #ffffff;

  /* Fills: translucent, for controls on any surface */
  --color-fill: rgb(120 120 128 / 0.2);
  --color-fill-secondary: rgb(120 120 128 / 0.16);
  --color-fill-tertiary: rgb(118 118 128 / 0.12);
  --color-fill-quaternary: rgb(116 116 128 / 0.08);

  /* Labels */
  --color-label: #1d1d1f;
  --color-label-secondary: #6e6e73;
  --color-label-tertiary: #86868b;
  --color-label-on-color: #ffffff;

  /* Lines and control parts */
  --color-separator: #d2d2d7;
  --color-control: #86868b;
  --color-thumb: #ffffff;
  --color-scrim: rgb(0 0 0 / 0.4);

  /* Accent */
  --color-accent: #0071e3;
  --color-accent-hover: #0066cc;
  --color-accent-pressed: #005bb8;
  --color-accent-label: #0060c0;
  --color-accent-tint: rgb(0 113 227 / 0.12);
  --color-accent-tint-hover: rgb(0 113 227 / 0.16);

  /* Live */
  --color-live: #e0182d;

  /* Status: the base value is text- and icon-safe; the tint is a background */
  --color-success: #18732f;
  --color-success-tint: rgb(52 199 89 / 0.12);
  --color-warning: #a34900;
  --color-warning-tint: rgb(255 149 0 / 0.12);
  --color-danger: #c40013;
  --color-danger-tint: rgb(255 59 48 / 0.12);
  --color-danger-tint-hover: rgb(255 59 48 / 0.16);

  --color-focus: #0060c0;

  /* Material backgrounds; blur and fallbacks live in the material-* utilities */
  --color-material-bar: rgb(251 251 253 / 0.8);
  --color-material-bar-solid: #fbfbfd;
  --color-material-thick: rgb(255 255 255 / 0.86);
  --color-material-overlay: rgb(28 28 30 / 0.72);
  --color-material-overlay-solid: rgb(28 28 30 / 0.92);

  /* Charts (admin) */
  --color-chart-1: #0071e3;
  --color-chart-2: #c95f00;
  --color-chart-3: #9a4fd6;
  --color-chart-4: #1a8a72;
  --color-chart-grid: #e8e8ed;
  --color-chart-muted: #86868b;

  /* Type */
  --font-sans:
    -apple-system, BlinkMacSystemFont, var(--font-inter), system-ui, "Segoe UI", Roboto, "Helvetica Neue",
    Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;

  --text-caption: 0.75rem;
  --text-caption--line-height: 1rem;
  --text-caption--letter-spacing: 0em;
  --text-caption--font-weight: 400;
  --text-footnote: 0.8125rem;
  --text-footnote--line-height: 1.125rem;
  --text-footnote--letter-spacing: -0.003em;
  --text-footnote--font-weight: 400;
  --text-callout: 0.9375rem;
  --text-callout--line-height: 1.25rem;
  --text-callout--letter-spacing: -0.008em;
  --text-callout--font-weight: 400;
  --text-body: 1.0625rem;
  --text-body--line-height: 1.5625rem;
  --text-body--letter-spacing: -0.016em;
  --text-body--font-weight: 400;
  --text-headline: 1.0625rem;
  --text-headline--line-height: 1.375rem;
  --text-headline--letter-spacing: -0.016em;
  --text-headline--font-weight: 600;
  --text-intro: 1.1875rem;
  --text-intro--line-height: 1.6875rem;
  --text-intro--letter-spacing: -0.008em;
  --text-intro--font-weight: 400;
  --text-title-3: 1.25rem;
  --text-title-3--line-height: 1.5rem;
  --text-title-3--letter-spacing: -0.008em;
  --text-title-3--font-weight: 600;
  --text-title-2: 1.5rem;
  --text-title-2--line-height: 1.75rem;
  --text-title-2--letter-spacing: -0.01em;
  --text-title-2--font-weight: 600;
  --text-title-1: 1.75rem;
  --text-title-1--line-height: 2rem;
  --text-title-1--letter-spacing: -0.012em;
  --text-title-1--font-weight: 600;
  --text-display-2: 2.5rem;
  --text-display-2--line-height: 2.75rem;
  --text-display-2--letter-spacing: -0.014em;
  --text-display-2--font-weight: 600;
  --text-display-1: 3rem;
  --text-display-1--line-height: 3.25rem;
  --text-display-1--letter-spacing: -0.016em;
  --text-display-1--font-weight: 600;

  /* Shape */
  --radius-xs: 0.25rem;
  --radius-sm: 0.5rem;
  --radius-md: 0.75rem;
  --radius-lg: 1.125rem;
  --radius-xl: 1.75rem;

  /* Elevation: read through the elevation-* utilities so dark mode can swap them */
  --elevation-1: 0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px rgb(0 0 0 / 0.06);
  --elevation-2: 0 2px 6px rgb(0 0 0 / 0.04), 0 12px 32px rgb(0 0 0 / 0.1);
  --elevation-3: 0 4px 12px rgb(0 0 0 / 0.06), 0 24px 64px rgb(0 0 0 / 0.18);
  --elevation-thumb: 0 3px 8px rgb(0 0 0 / 0.12), 0 3px 1px rgb(0 0 0 / 0.04);

  /* Motion */
  --ease-standard: cubic-bezier(0.25, 0.1, 0.25, 1);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-sheet: cubic-bezier(0.32, 0.72, 0, 1);

  --animate-spin: spin 0.8s linear infinite;
  --animate-live-pulse: live-pulse 1.6s var(--ease-standard) 3;
  --animate-indeterminate: indeterminate 1.2s var(--ease-standard) infinite;

  @keyframes spin {
    to {
      transform: rotate(1turn);
    }
  }
  @keyframes live-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @keyframes indeterminate {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(250%);
    }
  }

  /* Layout */
  --breakpoint-sm: 735px;
  --breakpoint-md: 1069px;
  --breakpoint-lg: 1441px;

  --container-form: 37.5rem;
  --container-text: 42.5rem;
  --container-content: 61.25rem;
  --container-wide: 75rem;
  --container-full: 90rem;
}

@layer base {
  /* color-scheme sits with the tokens so the dark rule overrides it at equal specificity, later in source. */
  :root,
  [data-theme="dark"] {
    color-scheme: light;

    @variant dark {
      color-scheme: dark;

      --color-bg: #000000;
      --color-bg-secondary: #1c1c1e;
      --color-canvas: #000000;
      --color-surface: #1c1c1e;
      --color-surface-raised: #2c2c2e;

      --color-fill: rgb(120 120 128 / 0.36);
      --color-fill-secondary: rgb(120 120 128 / 0.32);
      --color-fill-tertiary: rgb(118 118 128 / 0.24);
      --color-fill-quaternary: rgb(118 118 128 / 0.18);

      --color-label: #f5f5f7;
      --color-label-secondary: #a1a1a6;
      --color-label-tertiary: #7c7c80;

      --color-separator: #424245;
      --color-control: #7c7c80;
      --color-thumb: #636366;
      --color-scrim: rgb(0 0 0 / 0.6);

      --color-accent-label: #409cff;
      --color-accent-tint: rgb(64 156 255 / 0.14);
      --color-accent-tint-hover: rgb(64 156 255 / 0.18);

      --color-success: #30d158;
      --color-success-tint: rgb(48 209 88 / 0.16);
      --color-warning: #ff9f0a;
      --color-warning-tint: rgb(255 159 10 / 0.16);
      --color-danger: #ff6961;
      --color-danger-tint: rgb(255 69 58 / 0.16);
      --color-danger-tint-hover: rgb(255 69 58 / 0.2);

      --color-focus: #409cff;

      --color-material-bar: rgb(22 22 23 / 0.8);
      --color-material-bar-solid: #161617;
      --color-material-thick: rgb(44 44 46 / 0.86);

      --color-chart-1: #2b8cf2;
      --color-chart-2: #d97400;
      --color-chart-3: #a35ee6;
      --color-chart-4: #1f9a80;
      --color-chart-grid: #2c2c2e;
      --color-chart-muted: #7c7c80;

      --elevation-1: 0 0 0 1px rgb(255 255 255 / 0.06);
      --elevation-2: 0 0 0 1px rgb(255 255 255 / 0.08), 0 12px 32px rgb(0 0 0 / 0.5);
      --elevation-3: 0 0 0 1px rgb(255 255 255 / 0.08), 0 24px 64px rgb(0 0 0 / 0.6);
      --elevation-thumb: 0 3px 8px rgb(0 0 0 / 0.24);
    }
  }
}
```

```css
/* apps/web/styles/base.css */
@layer base {
  :root {
    --nav-height: 3rem;
    --page-margin: 1.25rem;
    --section-space: 4rem;
    --grid-gap: 1rem;
    --safe-x: max(env(safe-area-inset-left), env(safe-area-inset-right));
    --bottom-bar-height: 0px;
    --z-raised: 10;
    --z-sticky: 20;
    --z-nav: 30;
    --z-toast: 40;
    --z-skip-link: 50;
    scrollbar-gutter: stable;
    scroll-padding-block: calc(var(--nav-height) + 1rem) calc(var(--bottom-bar-height) + 1rem);
  }

  /* Apple platforms render SF Pro (§3.1), which takes apple.com's tracking rather than Inter's (§3.2). */
  :root[data-font="sf"] {
    --text-callout--letter-spacing: -0.016em;
    --text-body--letter-spacing: -0.022em;
    --text-headline--letter-spacing: -0.022em;
    --text-intro--letter-spacing: 0.012em;
    --text-title-3--letter-spacing: 0.012em;
    --text-title-2--letter-spacing: 0.009em;
    --text-title-1--letter-spacing: 0.007em;
    --text-display-2--letter-spacing: 0em;
    --text-display-1--letter-spacing: -0.003em;
  }

  :root:has([data-bottom-bar]) {
    --bottom-bar-height: 4.5rem;
  }

  :root:has(dialog:modal) {
    overflow: hidden;
  }

  @media (width >= 735px) {
    :root {
      --page-margin: 2rem;
      --section-space: 5rem;
      --grid-gap: 1.25rem;
      --text-intro: 1.3125rem;
      --text-intro--line-height: 1.8125rem;
      --text-title-1: 2rem;
      --text-title-1--line-height: 2.25rem;
      --text-display-2: 3rem;
      --text-display-2--line-height: 3.25rem;
      --text-display-1: 4rem;
      --text-display-1--line-height: 4.25rem;
    }

    :root[data-font="sf"] {
      --text-intro--letter-spacing: 0.011em;
      --text-title-1--letter-spacing: 0.004em;
      --text-display-2--letter-spacing: -0.003em;
      --text-display-1--letter-spacing: -0.009em;
    }
  }

  @media (width >= 1069px) {
    :root {
      --page-margin: 2.5rem;
      --section-space: 7rem;
      --grid-gap: 1.5rem;
      --text-title-2: 1.75rem;
      --text-title-2--line-height: 2rem;
      --text-title-1: 2.5rem;
      --text-title-1--line-height: 2.75rem;
      --text-display-2: 3.5rem;
      --text-display-2--line-height: 3.75rem;
      --text-display-1: 5rem;
      --text-display-1--line-height: 5.25rem;
    }

    :root[data-font="sf"] {
      --text-title-2--letter-spacing: 0.007em;
      --text-title-1--letter-spacing: 0em;
      --text-display-2--letter-spacing: -0.005em;
      --text-display-1--letter-spacing: -0.015em;
    }
  }

  body {
    background-color: var(--color-bg);
    color: var(--color-label);
    font-family: var(--font-sans);
    font-size: var(--text-body);
    font-weight: var(--text-body--font-weight);
    line-height: var(--text-body--line-height);
    letter-spacing: var(--text-body--letter-spacing);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* The page background is set on body and the root, not on a wrapper, so overscroll and the scrollbar match. */
  body:has([data-page="grouped"]) {
    background-color: var(--color-canvas);
  }

  /* The live room is always dark (§10.3). Its dark tokens are scoped to the route's wrapper and the root keeps the
     light ones, so the dark bg value is written out here. */
  :root:has([data-page="live"]),
  :root:has([data-page="live"]) body {
    color-scheme: dark;
    background-color: #000000;
  }

  h1,
  h2,
  h3,
  h4 {
    text-wrap: balance;
  }

  p,
  li,
  dd {
    text-wrap: pretty;
  }

  b,
  strong {
    font-weight: 600;
  }

  :focus-visible {
    outline: 3px solid var(--color-focus);
    outline-offset: 2px;
  }

  ::selection {
    background-color: var(--color-accent-tint-hover);
  }

  input:autofill,
  select:autofill,
  textarea:autofill {
    -webkit-text-fill-color: var(--color-label);
    caret-color: var(--color-label);
    box-shadow: inset 0 0 0 100vmax var(--color-surface);
  }

  dialog {
    opacity: 0;
    scale: 0.96;
    transition:
      opacity 200ms var(--ease-in),
      scale 200ms var(--ease-in),
      overlay 200ms allow-discrete,
      display 200ms allow-discrete;
  }

  dialog[open] {
    opacity: 1;
    scale: 1;
    transition-duration: 300ms;
    transition-timing-function: var(--ease-sheet);
  }

  dialog::backdrop {
    /* Older engines do not let ::backdrop inherit custom properties, hence the literal fallback. */
    background-color: var(--color-scrim, rgb(0 0 0 / 0.4));
    opacity: 0;
    transition:
      opacity 200ms var(--ease-in),
      overlay 200ms allow-discrete,
      display 200ms allow-discrete;
  }

  dialog[open]::backdrop {
    opacity: 1;
    transition-duration: 300ms;
  }

  @starting-style {
    dialog[open] {
      opacity: 0;
      scale: 0.96;
    }

    dialog[open]::backdrop {
      opacity: 0;
    }
  }

  /* Below 735 px a sheet's panel moves with motion (§9.14) and close() runs after its exit, so the dialog box
     must not fade or linger, and the backdrop starts fading when the exit starts (data-closing). */
  @media (width < 735px) {
    dialog[data-sheet] {
      opacity: 1;
      scale: none;
      transition: none;
    }

    dialog[data-sheet][data-closing]::backdrop {
      opacity: 0;
      transition-duration: 200ms;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    dialog,
    dialog[open] {
      scale: none;
    }
  }
}
```

```css
/* apps/web/styles/utilities.css */
@utility page-* {
  width: min(100% - 2 * (var(--page-margin) + var(--safe-x)), --value(--container-*));
  margin-inline: auto;
}

@utility elevation-* {
  box-shadow: --value(--elevation-*);
}

@utility material-bar {
  background-color: var(--color-material-bar);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    background-color: var(--color-material-bar-solid);
  }
  @media (prefers-reduced-transparency: reduce) {
    background-color: var(--color-material-bar-solid);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

@utility material-thick {
  background-color: var(--color-material-thick);
  -webkit-backdrop-filter: saturate(180%) blur(30px);
  backdrop-filter: saturate(180%) blur(30px);
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    background-color: var(--color-surface-raised);
  }
  @media (prefers-reduced-transparency: reduce) {
    background-color: var(--color-surface-raised);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

@utility material-overlay {
  --color-label: #ffffff;
  --color-label-secondary: rgb(255 255 255 / 0.8);
  --color-focus: #ffffff;
  color: var(--color-label);
  background-color: var(--color-material-overlay);
  -webkit-backdrop-filter: saturate(160%) blur(24px);
  backdrop-filter: saturate(160%) blur(24px);
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    background-color: var(--color-material-overlay-solid);
  }
  @media (prefers-reduced-transparency: reduce) {
    background-color: var(--color-material-overlay-solid);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

@utility skeleton {
  border-radius: var(--radius-sm);
  background-color: var(--color-fill-quaternary);
}
```

What the setup gives, verified against the 4.3.3 compiler:

- Utilities exist only for tokens: `bg-surface`, `text-label-secondary`, `border-control`, `text-title-1`, `rounded-lg`, `elevation-2`, `ease-out`, `max-w-text`, `page-wide`, `sm:`/`md:`/`lg:`. `bg-white`, `text-gray-500`, `text-sm`, `shadow-lg` and `font-serif` generate nothing.
- Colour utilities read variables (`var(--color-surface)`), so a dark override reaches every utility, including opacity modifiers such as `bg-label/35`.
- Variables that aren't theme tokens are used with the `(--var)` shorthand: `z-(--z-nav)`, `gap-(--grid-gap)`, `py-(--section-space)`, `h-(--nav-height)`.
- Tailwind's `hover:` already sits inside `@media (hover: hover)`, so touch devices never see sticky hover states.
- Spacing keeps Tailwind's default `--spacing: 0.25rem` (§4.1 lists the allowed steps).
- `color-scheme` follows the theme on the root and on every `data-theme="dark"` subtree, so scrollbars, `<select>` popups, the `datetime-local` picker, autofill and the dialog's system colours match the mode.
- Page backgrounds belong to the root, never to a wrapper: a grouped page marks its root element `data-page="grouped"` and the live room `data-page="live"`, and `base.css` paints `body` (and, for the live room, the root's `color-scheme`) from that. Overscroll, short pages and the Windows scrollbar gutter then match the page.
- `text-*` sets size, line height, tracking and weight together; the `--text-*--letter-spacing` values switch for SF Pro under `data-font="sf"`.

### 8.3 Light and dark

- Preference values are `system` (the default), `light` and `dark`. The preference is stored in `localStorage['fd-theme']`, per device, never on the server.
- `<html>` carries `data-theme="light"` or `data-theme="dark"` only when the user overrides the system; otherwise there is no attribute and `prefers-color-scheme` decides.
- An inline script, the first child of `<head>`, applies a stored override before first paint, so there is no flash. It also marks Apple platforms with `data-font="sf"`, because the font stack resolves to SF Pro there in every browser and SF Pro takes its own tracking (§3.2):

```tsx
// apps/web/components/theme/theme-script.tsx
// Storage can throw (private mode, blocked site data); the page then follows the system theme, which is the default.
const THEME_SCRIPT = `var d=document.documentElement;if(/Mac|iPhone|iPad|iPod/.test(navigator.platform))d.dataset.font="sf";try{var t=localStorage.getItem("fd-theme");if(t==="light"||t==="dark")d.dataset.theme=t}catch(e){}`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
```

- `<html suppressHydrationWarning>` is required, because the script adds attributes to an element that React rendered. If a Content Security Policy is added later, this script needs a nonce or a hash.
- The theme switcher is a small segmented control in the footer: Automatic, Light, Dark (icons `Monitor`, `Sun`, `Moon`). Light or Dark sets the attribute and the storage key; Automatic removes both.
- **Scoped dark.** Any element with `data-theme="dark"` renders its subtree dark: the token variables and `color-scheme: dark` are declared on it, so native controls and scrollbars inside it follow. The live room uses this (§10.3), and its `data-page="live"` also makes the root's scrollbar and background dark. A light subtree inside a dark page is not supported.
- The `dark:` variant exists, with the same two conditions, for rare non-colour differences. Components **must not** use it for colours.
- The root viewport export:

```ts
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
    { media: '(prefers-color-scheme: dark)', color: '#161617' },
  ],
};
```

The live room exports `themeColor: '#161617'`.

### 8.4 Root layout

```tsx
// apps/web/app/layout.tsx (shape)
<html lang="en" className={inter.variable} suppressHydrationWarning>
  <head>
    <ThemeScript />
  </head>
  <body>
    <SkipLink />
    <Providers>{children}</Providers>
  </body>
</html>
```

`Providers` (a client component) holds `LucideProvider` (§7), `MotionProvider` (§8.5), the `Announcer` live regions (§13.3) and the toast region (§9.15). Children stay Server Components.

### 8.5 Motion setup

`motion` 13.5.0, imported only from `motion/react`. Components use `m.*` inside `<LazyMotion strict>`; `strict` throws on `motion.*`, which would bundle every feature. Features load after hydration:

```tsx
// apps/web/components/ui/providers.tsx (excerpt)
'use client';
import { LazyMotion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

const loadMotionFeatures = () => import('./motion-features').then((mod) => mod.default);

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

// apps/web/components/ui/motion-features.ts
export { domMax as default } from 'motion/react';
```

`domMax` because shared-layout animation (segmented thumb, tab indicator) and drag (phone sheet) need it.

### 8.6 Dependencies

Added by this design system:

| Package | Version | Why | Rejected |
|---|---|---|---|
| `motion` | 13.5.0 | Interruptible springs, shared-layout animation, exit animation on unmount, drag | CSS only (no springs that can be interrupted, no exit on unmount); react-spring |
| `lucide-react` | 1.49.0 | One consistent stroke icon set, tree-shaken, defaults through `LucideProvider` | Heroicons (two fixed weights); SF Symbols (licence forbids web use) |
| Inter variable font | file from `@fontsource-variable/inter` 5.3.0 | Fallback typeface off Apple platforms (§3.1). Vendored, so not a runtime dependency | `next/font/google` (needs the network at build time) |

Already in the system design: `next` 16.3.8, `react` 19.3.0, `tailwindcss` and `@tailwindcss/postcss` 4.3.3, `recharts` 3.10.1 with `react-is`, `hls.js` 1.7.3.

Not added, with the native replacement:

| Need | Use | Not |
|---|---|---|
| Modal dialog, focus trap, inert background, Esc | `<dialog>` + `showModal()` | Radix Dialog, focus-trap |
| Radio groups, segmented control, select | Native `<input type="radio">` and `<select>` | Radix, Headless UI |
| Form state and pending state | `<form action>`, `useActionState`, `useFormStatus` | react-hook-form |
| Class composition | `cx()` (§8.7) | clsx, cva, tailwind-merge (it would need custom configuration to tell `text-body` (a size) from `text-label` (a colour)) |
| Dates, numbers, plurals | `Intl` | date-fns, numeral |
| Toasts | `components/ui/toast.tsx` | sonner, react-hot-toast |
| Carousel | CSS scroll snap | Embla, Swiper |
| Theme | `ThemeScript` + switcher (§8.3) | next-themes |
| Menus and popovers | None needed in v1 (§9 has no menus). If one is needed later: the `popover` attribute | Floating UI |

Any other UI dependency needs a row in the first table, with a reason, before it is installed.

### 8.7 Conventions

- Variants are props mapped to class strings in a typed object:

```ts
const variantClass = {
  filled: 'bg-accent text-label-on-color hover:bg-accent-hover active:bg-accent-pressed',
  tinted: 'bg-accent-tint text-accent-label hover:bg-accent-tint-hover active:bg-accent-tint-hover',
  gray: 'bg-fill-tertiary text-label hover:bg-fill-secondary active:bg-fill',
  plain: 'text-accent-label hover:bg-fill-quaternary active:bg-fill-tertiary',
} as const satisfies Record<ButtonVariant, string>;
```

- `cx` joins classes:

```ts
// apps/web/lib/cx.ts
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
```

- A primitive's `className` prop is for layout only (margin, width, grid placement). Colour, type and shape come from its props.
- Server Components by default. `'use client'` only for islands that need state, effects or browser APIs: `LiveStock`, `BuyButton`, `Countdown`, `LocalTime`, `Player`, `ThemeSwitcher`, the checkout form, the listing review and admin charts.
- Recharts and hls.js load through `next/dynamic` with `ssr: false`, so storefront bundles never include them. `ssr: false` is an error in a Server Component, so each dynamic import lives in a small `'use client'` wrapper: `components/admin/chart-frame.tsx` loads `chart-view.tsx`, and `components/live/player.tsx` loads `player-view.tsx`. Their `loading` skeletons have the final size.
- All countdowns read one shared clock (`lib/clock.ts`): one `setTimeout` chain aligned to second boundaries, running while at least one countdown is mounted, paused while the tab is hidden and resynced on `visibilitychange`.
- No hex colours or pixel font sizes in `.tsx` files. Reviewers grep for `#[0-9a-fA-F]{3,8}\b` and `text-\[`.

### 8.8 Token test

`apps/web/styles/tokens.test.ts` (Vitest, `unit` project) parses `tokens.css` and checks:

1. Every colour and elevation variable in the dark block also exists in `@theme`. The colour tokens that are deliberately the same in both modes are listed in the test: `accent`, `accent-hover`, `accent-pressed`, `live`, `label-on-color`, `material-overlay`, `material-overlay-solid`.
2. Every pair in Appendix A meets its ratio, computed from the parsed values, with translucent colours composited over the stated backgrounds. Material pairs are composited twice: the material over the worst content (black under a light material, white under a dark one, a white frame under `material-overlay`), then the foreground over that.

Changing a colour without keeping its contrast fails CI.

---

## 9. Components

### 9.0 Shared states

Every interactive component implements these states the same way.

| State | Treatment |
|---|---|
| Rest | As specified per component |
| Hover | Pointer devices only (`hover:`). One step of the fill or colour ramp, 200 ms `ease-standard` (tiles: §9.7) |
| Pressed | `active:` pressed colour, applied at once. Buttons never scale |
| Focus-visible | 3 px `focus` outline at 2 px offset, following the element's radius. `outline-none` is allowed only when the component draws an equivalent ring on a wrapper (segmented control, radio card, product tile) |
| Disabled | `aria-disabled="true"`, never `disabled`, so the control stays focusable and can explain itself. Clicks are ignored in the handler. Filled and tinted become `bg-fill-tertiary text-label-tertiary`; plain becomes `text-label-tertiary` |
| Loading | `aria-busy="true"`. A spinner (`LoaderCircle` + `animate-spin`, 16 or 20 px) replaces the leading icon or is prepended. The label changes to a progressive verb ("Reserving…"). Width is locked to the rest width so nothing moves. Repeated activation is ignored |

Target size: md and lg controls are at least 44 × 44 px. sm controls (32 px) appear only in admin, dense toolbars and the footer. Segmented controls (28 and 36 px) are the one exception to the 44 px rule for md: they appear only in admin and the footer. Nothing is smaller than 24 × 24 px (WCAG 2.5.8) except inline text links.

### 9.1 Button

Anatomy: optional leading icon, label, optional trailing icon. The spinner takes the leading slot.

| Variant | Rest | Hover | Pressed | Use |
|---|---|---|---|---|
| Filled | `accent`, `label-on-color` text | `accent-hover` | `accent-pressed` | The one primary action of a region |
| Tinted | `accent-tint`, `accent-label` text | `accent-tint-hover` | `accent-tint-hover` | A secondary action beside a filled button ("Watch live", "Add 1 minute") |
| Gray | `fill-tertiary`, `label` text | `fill-secondary` | `fill` | Everyday actions without emphasis ("Cancel", "Edit") |
| Plain | transparent, `accent-label` text | `fill-quaternary` | `fill-tertiary` | Low-emphasis actions ("Looks right", "Pause updates") |

Two tones change the colours of a variant:

- **Destructive** swaps the text to `danger`; on tinted, the background becomes `danger-tint` and hover and pressed `danger-tint-hover`. It is used for "Leave" and "End drop".
- **Neutral** swaps a plain button's text from `accent-label` to `label`. Plain buttons on `material-bar` and `material-thick` **must** use it (§2.5), for example "Leave checkout" in the reduced navigation bar.

| Size | Height | Horizontal padding | Label | Icon | Gap |
|---|---|---|---|---|---|
| sm | 32 | 12 (10 on the icon side) | `text-footnote font-medium` | 16 | 6 |
| md | 44 | 20 (16 on the icon side) | `text-callout font-medium` | 16 | 6 |
| lg | 56 | 28 (24 on the icon side) | `text-body font-medium` | 20 | 8 |

- Shape: `pill` (`rounded-full`, the default) or `rounded` (`rounded-md`), which is for full-width buttons in checkout, dialogs and the login card.
- Full width (`w-full`) for the lg Buy button on phone, the Pay button and the login Continue button.
- A button that navigates is an `<a>` styled as a button ("Watch live", "Try again" to the product page). A button that acts is a `<button type="button">`, or `type="submit"` inside its form.
- On `material-overlay` only filled buttons carry text (white on `accent` keeps 4.70:1 there); everything else on video is an overlay icon button (§9.2) or a text control inside a player capsule (§10.3).

### 9.2 Icon button

- Circle, 32 px (icon 16) or 44 px (icon 20).
- Variants: gray (`fill-tertiary`), plain (transparent, `fill-quaternary` on hover) and overlay (on `material-overlay`: transparent, white icon, `bg-label/16` on hover and `bg-label/24` pressed, where `label` is white inside the material). On `material-bar` and `material-thick` the plain variant's icon is `label`.
- `aria-label` is required. Toggles (mute, captions, pause updates) use `aria-pressed`.

### 9.3 Segmented control

Use it to pick one of 2 to 5 values that filter or switch a view: the admin drop filter, the footer appearance switch. It is not navigation (use links) and not a tab set (use tabs, §9.21).

- Anatomy: a track (`fill-tertiary`, `rounded-full`, 2 px padding), a thumb (`thumb`, `elevation-thumb`, `rounded-full`) and equal-width segments (`grid-auto-flow: column; grid-auto-columns: 1fr`). Labels are at most 12 characters.
- Sizes: sm is 28 px tall (thumb 24) with `text-footnote font-medium`; md is 36 px tall (thumb 32) with `text-callout font-medium`. The selected label is `font-semibold`.
- Implementation: a `<fieldset>` with a visually hidden `<legend>`. Each segment is a `<label>` holding a visually hidden `<input type="radio">` and its text. The thumb is an `m.span` with a shared `layoutId`, rendered inside the checked label, moving with `snappy`.
- Keyboard comes from the native radio group: Tab enters the group, the arrow keys move and select.
- Focus: the segment's `<label>` draws the standard ring while its radio has focus (`has-[:focus-visible]:` variants for the outline width, colour and offset).

### 9.4 Text field, textarea and select

Apple-style floating label: there is no placeholder, and the label sits where a placeholder would.

```
┌──────────────────────────────────────────┐  56 px tall, rounded-md, 1 px control border, surface, 16 px side padding
│ Full name                                │  raised label: 12 px (scaled), label-secondary, top at 8 px
│ Mira Chen                                │  value: body 17/25, label, top at 24 px
└──────────────────────────────────────────┘
  Enter your full name.                       footnote, 8 px below; danger with CircleAlert 16 on error
```

- The label is absolutely positioned at `top: 16px` in body 17/25 and `label-secondary`, which centres it in the empty field. On focus, or when filled, it takes the raised position with `transform: translateY(-8px) scale(0.706)` (12 / 17) and `transform-origin: left top`, over 200 ms `ease-out`, `motion-safe:` only (with reduced motion it jumps). The input carries `placeholder=" "` so CSS can read `:placeholder-shown`, and pads 24 px at the top.
- Hover: the border becomes `label-secondary`. Focus: the global focus ring.
- Error: a 1 px `danger` border, the message under the field with `CircleAlert` 16, `aria-invalid="true"`, and `aria-describedby` pointing at the error id first and then the helper id.
- Disabled: `fill-quaternary` background, `label-tertiary` text, `separator` border. Read-only: no border, `fill-quaternary` background.
- Every field sets `type`, `inputMode` and `autoComplete` (checkout tokens in §10.4). Format hints go in the helper text ("5 digits"), never in a placeholder.
- **Textarea:** same anatomy, label always raised, minimum 120 px tall, `resize: vertical`. An optional counter sits at the bottom right in `text-footnote tabular-nums` ("42/80") and turns `danger` outside its limits.
- **Select:** a native `<select>` with `appearance: none` in the same container. The label is always raised, and a `ChevronDown` 16 in `label-secondary` sits 16 px from the right. Options stay native.
- Prefixes and suffixes ("$", "units") are `label-secondary` text inside the container, outside the input's own box.

### 9.5 Radio group and radio card

- **Radio:** a native `<input type="radio">` with `appearance: none`. 22 px circle, 1 px `control` border. Checked: `accent` fill and an 8 px `label-on-color` dot in the centre. The whole row is the `<label>`, at least 44 px tall, with the text at 12 px from the circle.
- **Radio card** (payment methods, login accounts): a `<label>` block, `rounded-md`, padding 12 px × 16 px, at least 56 px tall, 1 px `control` border. Inside: the radio, a title (`text-body font-medium`), an optional description (`text-footnote text-label-secondary`) and an optional trailing element (avatar, pill). Checked: `border-accent` plus `ring-1 ring-inset ring-accent`, which looks like 2 px without moving the layout. The focus ring goes on the card through `has-[:focus-visible]`.
- Groups are a `<fieldset>` with a `<legend>` (`text-title-3`, or visually hidden when the page heading already says it). Arrow keys move the selection natively.

### 9.6 Quantity stepper

```
( −   2   + )    44 px tall pill, fill-tertiary
```

- Two 44 px round icon buttons (`Minus`, `Plus` at 16) and the value in `text-headline tabular-nums`, at least 32 px wide.
- `role="group"` with `aria-labelledby` pointing at a visible or visually hidden "Quantity" label. The buttons are labelled "Decrease quantity" and "Increase quantity" and use `aria-disabled` at 1 and at the drop's per-user limit. The value sits in an `<output aria-live="polite">`.
- The limit is stated next to it: "Limit 2 per person". With a limit of 1 the stepper is not rendered and only the limit text remains.

### 9.7 Product tile

```
┌──────────────────────┐   image well: aspect 4/5, rounded-lg, bg-secondary, overflow-clip
│ [LIVE]               │   LIVE badge 12 px from the top-left corner, live drops only, never pulsing
│                      │
│     product photo    │
│                      │
└──────────────────────┘
 Starts in 2:14:09         footnote, label-secondary (16 px below the well)
 Halo Over-Ear             title-3, two lines at most (4 px below)
 $249                      body, tabular (4 px below)
```

- The meta line is "Starts in 2:14:09" (scheduled, §9.10), "{N} left" or "Only {N} left" (live; the urgent form in `danger`, §9.9), "Sold out" or "Ended".
- The title is an `<a>` inside an `<h3>`, stretched over the tile with `after:absolute after:inset-0`. The tile is an `<article>` and is one tab stop. The photo has `alt=""` because the title names it. No other interactive element goes inside a tile.
- Hover (pointer): the image well alone gets `elevation-2` over 300 ms `ease-out` and the tile takes `z-(--z-raised)`. The image never scales, and the text below the well doesn't move. Pressed (touch): the well gets `motion-safe:active:scale-98`.
- Focus: the link sets `focus-visible:outline-none` and the article draws the ring around the well with `has-[a:focus-visible]`.
- A sold-out tile keeps its photo at full strength; the text says it is sold out.
- Skeleton: the 4:5 well, then three bars of 96 px, 70% and 48 px wide at the footnote, title-3 and body line heights.

### 9.8 Price

`<Price cents currency size>` formats through `lib/format.ts` (§3.3), always with `tabular-nums`.

| Size | Style | Use |
|---|---|---|
| inherit | The parent's style | Tiles, drop card, tables |
| `lg` | `text-title-2` | Product purchase panel |
| `total` | `text-headline` | Checkout and order totals |

A price is never coloured and never struck through (the data model has no compare-at price).

### 9.9 Stock meter and LiveStock

**Stock meter.** A bar with three segments in order: sold, then held, then available (the track).

| Size | Height | Where |
|---|---|---|
| sm | 4 px | Drop card, admin table rows (64 px wide) |
| md | 6 px | Product purchase panel, home hero (up to 360 px wide) |
| lg | 12 px | Admin drop page and dashboard, with a legend |

- `rounded-full` on the outer ends, 2 px gaps between segments (the background shows through).
- Colours: sold is `label`, held is `label` at 35% (`bg-label/35`), available is `fill-secondary`. **Urgent** (available > 0 and available ≤ max(5, ⌈10% of total⌉)): sold and held switch to `danger` and `danger/35`, the same red as the urgent text above the meter. In admin, sold is `chart-1`, held is `chart-2` and available stays the track, with a legend showing the numbers.
- The meter is `aria-hidden="true"`; the text carries the meaning.

**LiveStock** renders the text and the meter from the `(gen, seq)`-ordered state (SD §8.2). It shows SD §8.2's three states with one refinement: "Only" is reserved for urgent stock, so a large remainder reads "{N} left" (§1.5, Appendix B). "All reserved, N in carts, may free up" is split over two lines.

| Condition | Primary line (`text-headline`) | Secondary line (`text-footnote text-label-secondary`) | Meter | Buy button |
|---|---|---|---|---|
| Scheduled, under 24 h to start | "Starts in 4:09" | "{total} available · Limit {n} per person" | Hidden | "Opens at 7:00 PM" if it opens today, otherwise "Opens Tue, Oct 6"; static, disabled look |
| Scheduled, 24 h or more to start | "Starts Tue, Oct 6 at 7:00 PM" | "{total} available · Limit {n} per person" | Hidden | "Opens Tue, Oct 6"; static, disabled look |
| Live, `avail > 0` | "{avail} left" | "{sold + held} of {total} claimed" | Normal | "Buy" |
| Live, `avail > 0`, urgent | "Only {avail} left", in `danger` on surfaces | "{sold + held} of {total} claimed" | Urgent | "Buy" |
| `avail = 0`, `held > 0` | "All reserved" | "{held} in carts, may free up" | Full; the held segment shows | "All reserved", disabled look. Re-enables by itself when `avail > 0` |
| `avail = 0`, `held = 0` | "Sold out" | "All {total} sold" | Full | "Sold out", disabled look |
| Paused | "Paused" | "Sales are paused. This page updates when they resume." | Unchanged | "Paused", disabled look |
| Ended | "Drop ended" | "{sold} of {total} sold" | Unchanged | Not rendered |
| Socket down for more than 5 s (SD §7) | Unchanged | Adds `WifiOff` 16 + "Live updates paused" | Unchanged | Unchanged |

- On a material (the sticky buy bar, the docked drop card) the primary line is always `label`, urgent or not; there the word "Only" carries the urgency (§2.5).
- The block reserves its full height (22 + 4 + 18 + 8 + meter) so changing state never moves the layout.
- The number changes with the stock-number motion (§6.4). The visible block is **not** a live region.
- SSR renders the snapshot's text and number, so the raw HTML contains them (SD §8.1). The Suspense fallback is a skeleton of the same size.
- Announcements go through a separate visually hidden polite region, and only on these events: crossing to 10 or fewer left, 5 or fewer, 1 left; becoming all reserved ("All reserved. Some may free up."); becoming sold out; and going from 0 back above 0 ("Available again. {n} left."). At most one announcement per 3 s, the latest state wins, and nothing is announced on first load.

### 9.10 Countdown

`<Countdown target serverNow variant onEnd>` is a client component on the shared clock (§8.7).

| Variant | Look | Use |
|---|---|---|
| `inline` | Inherits; "Starts in 2:14:09", "Ends in 12:04" | Tiles, LiveStock, drop card status line |
| `hero` | `text-title-2 tabular-nums` | Home hero before a drop opens |
| `hold` | §10.4 | Checkout only |

- A countdown runs only for deadlines under 24 hours (§3.3). Further out, the same slot renders `<LocalTime>` with the same verb ("Starts Tue, Oct 6 at 7:00 PM", "Ends Tue, Oct 6 at 7:30 PM"), and the component switches to digits by itself when the deadline comes within 24 hours. The verb for an opening is always "Starts", on tiles, LiveStock and the hero alike.
- Time left is `target − (Date.now() + offset)`, where the offset comes from SSR `serverNow` or the socket's `hello.serverTime` (SD §8.1, §8.3). It never shows a negative value. At zero it calls `onEnd` and shows "Starting…" until the stock snapshot reports LIVE.
- The digits are `aria-hidden="true"`. A visually hidden sibling gives a stable equivalent ("Starts at 7:00 PM") that doesn't change every second. Only the checkout hold announces anything (SD §8.3).

### 9.11 LIVE badge and viewer count

- **LIVE badge.** 24 px tall (20 px on tiles), 8 px horizontal padding (6 on tiles), `rounded-xs`, `bg-live`, `text-caption font-semibold uppercase tracking-[0.04em] text-label-on-color`, with a 6 px `label-on-color` dot before the text. The DOM text is "Live", so screen readers don't spell it. It is shown only while the drop or room is LIVE.
- **Pulse.** Only the home hero badge and the live room's badge pulse (`motion-safe:animate-live-pulse`: three cycles, 4.8 s, then still), together with the navigation bar's live dot (§9.18). Badges on tiles, in drop cards and in tables are always still, so a page never has more than two pulsing dots and nothing pulses past 5 s (WCAG 2.2.2).
- **Viewer count.** A 24 px pill with 8 px padding: `material-overlay` on video, `fill-tertiary` elsewhere. `Eye` 14, the number in `text-caption font-medium tabular-nums`, then a visually hidden " watching". It updates at most every 5 s (the gateway's cadence, SD §7), is never announced and shows the real count, including 1.

### 9.12 Drop card

The purchase unit next to live video and in the home hero.

```
┌────────────────────────────────────────────────┐  rounded-lg, surface, elevation-1, padding 20 / 24
│ ┌──────┐  [LIVE]  Ends in 12:04                │  thumb 72 × 72, rounded-md; status line footnote
│ │thumb │  Aurora Runner 2                      │  title-3
│ └──────┘  $129                                 │  body, tabular
│                                                │
│ Only 12 left              488 of 500 claimed   │  LiveStock, meter sm
│ ███████████████████████████████░░░             │
│ ( −  1  + )   [            Buy            ]    │  stepper + lg filled pill, 12 px gap
│ Limit 2 per person · Held 2 minutes at checkout│  footnote, label-secondary
└────────────────────────────────────────────────┘
```

- The **docked** variant is used when the player is fullscreen: 320 px wide, `material-overlay`, `elevation-2`, 16 px from the left edge and 84 px from the bottom, so it clears the control capsules (§10.3) and stays put when they hide. Thumb 48 px, title in `text-headline`, the stock primary line in white (never `danger`, §2.5) without the meter, and an md filled Buy button.
- When the room pins a different drop (`room` topic, SD §7), the card crossfades in 200 ms, focus stays where it is, and the polite region announces "Now selling: {title}".
- **Nothing pinned.** While the room has no pinned drop, the card keeps its size and shows "Nothing on sale right now" (`text-title-3`) and "The next drop appears here when it's pinned." (`text-callout text-label-secondary`), with no thumb, stock or button. A newly pinned drop crossfades in as above.

### 9.13 Buy button

A filled lg button that runs the reserve flow of SD §8.2.

| Situation | Label | Behaviour |
|---|---|---|
| Signed out | "Sign in to buy" | Link to `/login?returnTo=<current path>` |
| Before start, all reserved, sold out, paused | From the LiveStock table | `aria-disabled`, LiveStock explains why |
| Available | "Buy", or "Buy 2" when the quantity is 2 | Creates or reuses the `Idempotency-Key` (SD §8.2) |
| In flight | Spinner + "Reserving…" | `aria-busy` |
| 503 `RETRY` | "Reserving…", then "Still trying…" after 2 s | Retries with backoff and the same key. After 10 s in total it stops and shows an inline error with "Try again" |
| 201 or 200 | `Check` icon + "Reserved", `celebrate` spring, 400 ms | Then navigates to `/checkout/[orderId]` |
| 409, 410, 429 | Back to the rest label | Inline message under the button (§12.2), announced politely |

### 9.14 Dialog and sheet

**Alert dialog** (confirmations):

- A native `<dialog>` opened with `showModal()`, with `role="alertdialog"`, `aria-labelledby` (title) and `aria-describedby` (body).
- At most 400 px wide (`min(400px, 100% − 40px)`), `rounded-xl`, `surface`, `elevation-3`, 24 px padding. Title `text-title-3`, body `text-body text-label-secondary`, 24 px above the actions.
- Actions are right-aligned in a row from 735 px; on phone they stack full width with the primary action first. In a destructive confirmation (Leave, End drop) the safe action is the filled button and has initial focus (`autoFocus`), and the destructive action is plain with `danger` text. In a non-destructive one (Arm drop, Reconcile) the confirming action is filled and "Cancel" is gray, and "Cancel" still takes initial focus, so Enter never commits by accident.
- Esc chooses the safe action. Clicking the backdrop does nothing. Focus returns to the opener on close (native behaviour; `checkout-keyboard.spec` asserts it).

**Sheet** (bigger content, such as the admin "New drop" form):

- Markup: `<dialog data-sheet>` whose visible panel is an `m.div` inside it. The panel holds a sticky header with the title (`text-title-2`) and a close icon button, a scrolling body, and a sticky footer for actions on `material-bar`.
- From 735 px: a centred dialog, at most 560 px wide and 85dvh tall, `rounded-xl`, `elevation-3`. It opens and closes with the CSS dialog motion of `base.css` (§6.4); the panel itself doesn't animate.
- Below 735 px: a bottom sheet, full width, top corners `rounded-xl`, at most 92dvh tall, with a 36 × 5 px `fill` grabber (decorative, `aria-hidden`). `base.css` turns the dialog fade off at this width, and the panel moves instead:
  - Open: `showModal()`, then the panel animates from `y: '100%'` to 0 with `smooth`; the backdrop fades in through CSS.
  - Close (close button, Esc, backdrop click or drag): set `data-closing` on the `<dialog>` (the backdrop starts its 200 ms fade), animate the panel to `y: '100%'` in 200 ms `ease-in`, then call `dialog.close()` in `onAnimationComplete` and remove `data-closing`. Calling `close()` first would remove the panel before its exit could run.
  - Esc: the `cancel` event calls `preventDefault()` and runs the same close.
  - Drag: `drag="y"` with the top constrained to 0; releasing at a velocity over 500 px/s or an offset over 30% of the panel's height runs the close, anything less springs back with `smooth`. The close button is always there as the non-drag alternative (WCAG 2.5.7).
- Clicking the backdrop closes a sheet, unless the form inside has unsaved changes.
- Background scroll is locked by `:root:has(dialog:modal)`; `scrollbar-gutter: stable` keeps the page from jumping.

### 9.15 Toast and banner

**Toast.** Confirms a finished action that needs no response ("Published", "1 minute added"). Never for errors that need action, and never the only place where information appears.

- Bottom centre, 16 px above the safe area (and above a sticky bottom bar), `min(420px, 100% − 40px)` wide, `rounded-lg`, `material-thick`, `elevation-2`, 12 × 16 px padding. An icon (20) in its tone colour (the one non-`label` element allowed on the material, §2.5), `text-callout` text in `label`, and an optional action as a gray sm button (`bg-fill-tertiary text-label`).
- Up to three stack, newest at the bottom; the others move up with `smooth`.
- Visible for 5 s, paused while hovered or focused. A toast with an action also gets a close icon button (32).
- The region (`role="status"`) is always in the DOM, at `z-(--z-toast)`, so new toasts are announced politely.

**Banner.** An inline message at the top of the region it is about (page, card or form).

- `rounded-md`, 12 × 16 px padding, tone tint background, a 20 px icon in the tone colour, an optional `text-headline` title, `text-callout` body in `label`, an optional plain sm action or link, an optional dismiss button.
- Tones: info (`accent-tint`, `Info`), success, warning, danger.
- A banner appears on page load or as the result of the user's own action. It never pushes content down while the user is reading.
- `role="alert"` only for an error caused by the user's last action, and the error summary also takes focus (SD §8.3). Other banners are static.

### 9.16 Skeleton

- The `skeleton` utility: a still `fill-quaternary` block, with no shimmer or pulse. A skeleton has the final content's exact box: same width, height and radius. A text line is a block as tall as the style's font size, with vertical margins that make up the line height.
- SSR Suspense fallbacks render at once. Client-side loading shows a skeleton only after 300 ms, so fast responses don't flash.
- Skeletons are `aria-hidden="true"`; the region they fill has `aria-busy="true"` until the content arrives.

### 9.17 Empty state

```
            (icon 40, label-tertiary)
          No drops right now                    title-3
   New drops show up here. Check back soon.     callout, label-secondary, max 400 px
             [ optional action ]                md tinted pill
```

Centred, 64 px vertical padding, 12 px between icon and title, 8 px between title and text, 24 px above the action. The copy for each screen is in §12.2.

### 9.18 Navigation bar

```
desktop  ┌────────────────────────────────────────────────────────────────────────┐
         │ FlashDrop          Drops   ● Live                        Admin   (MC)  │  48 px, material-bar
         └────────────────────────────────────────────────────────────────────────┘
phone    ┌──────────────────────────────────────┐
         │ FlashDrop               [● Live] (MC)│
         └──────────────────────────────────────┘
```

- Sticky at the top, `z-(--z-nav)`, `material-bar`, 48 px plus the top safe area, content inside `page-wide` (`page-full` in admin).
- The wordmark "FlashDrop" is text in `text-headline`, linking to `/`.
- Everything on the bar is `label` (§2.5). Links (from 735 px) use `text-footnote` in `label` at 80% (`text-label/80`, 6.30:1 over the worst content), becoming full `label` on hover and with `aria-current="page"`. Each link is 44 px tall.
- "Live" appears only while a drop is LIVE, with a 6 px `live` dot (`motion-safe:animate-live-pulse`, three cycles, §9.11), and links to that drop's room. On phone it becomes a pill: `fill-tertiary`, dot and "Live" in `text-caption font-medium`.
- On the right: "Admin" (admins only, from 735 px), then the account avatar. It is a `size-11` (44 × 44) link with the 28 px avatar centred in it, `aria-label="Account, {name}"`, its initials `aria-hidden`, linking to `/login`, which doubles as the account page (§10.6). Signed-out users see "Sign in" instead, styled like the other links (`text-footnote text-label/80`, 44 px tall), on phone too.
- There is no menu button: with two links, the phone bar shows everything.
- The bottom hairline (`separator`) appears only when content is scrolled beneath the bar, toggled by an IntersectionObserver sentinel at the top of `<main>`.
- Checkout uses a reduced bar: the wordmark (not a link) and a plain neutral-tone "Leave checkout" button (`label` text, §9.1) on the right that opens the leave dialog (§10.4).
- The live room renders the bar inside its `data-theme="dark"` subtree (§10.3).

### 9.19 Large title

- On admin pages the `h1` (`text-title-1`) sits in the content with 32 px (phone) or 48 px (tablet and up) above it.
- When the `h1` scrolls under the navigation bar, the bar shows a compact copy in `text-headline` (centred on phone, after the wordmark on desktop) that fades in over 200 ms. The copy is `aria-hidden`; the `h1` stays the page's heading.

### 9.20 Footer

- `bg-secondary`, a `separator` hairline on top, `page-content`, 32 px (phone) or 40 px vertical padding, `text-footnote text-label-secondary`. Links turn `label` on hover.
- From 735 px, three columns: **Shop** (Drops, Live), **Account** (Sign in or Account, Admin for admins), **Project** (Source on GitHub and Image credits, each ending in `ArrowUpRight` 14, §7). On phone the groups stack.
- The appearance switch (§8.3) is a sm segmented control with icons and labels: Automatic, Light, Dark.
- The last line reads "FlashDrop is a demo store. No real payments are taken. MIT License."
- There is no footer in checkout, the live room or admin.

### 9.21 Tabs

Used to switch panels inside one admin page (for example Overview and Settings on a drop).

- `role="tablist"` with tabs 44 px tall, `text-callout font-medium` in `label-secondary`; the selected tab is `label` and `font-semibold`. A 2 px `label` indicator under the selected tab moves with `snappy`. A `separator` hairline runs under the whole tab list.
- Arrow keys move focus and selection (automatic activation), Home and End jump to the ends. Panels are `role="tabpanel"` with `tabIndex={0}`.

### 9.22 Data table (admin)

- Lives in a card (`surface`, `rounded-lg`, `elevation-1`, `overflow-clip`), with a `<caption>` (visually hidden when a heading already names the table). `overflow-clip` rounds the corners without creating a scroll container, so the sticky header below still reaches the viewport.
- Header row 36 px: `text-footnote font-medium text-label-secondary`, sentence case, solid `bg-surface` with a `separator` hairline below (no material, so `label-secondary` keeps 4.66:1 or more). From 735 px the header row is sticky at `top: calc(var(--nav-height) + env(safe-area-inset-top))` with `z-(--z-sticky)`; below 735 px it doesn't stick.
- Body rows at least 52 px tall, `text-callout`, 12 px cell padding (16 px on the outer cells), `separator` hairlines between rows. Rows have no hover fill, because only the first cell is a link and a row fill would suggest otherwise.
- Numbers are right-aligned with `tabular-nums`. Dates are short ("Oct 6, 7:00 PM"). Statuses are pills. Titles clamp at two lines. Ids use `font-mono text-footnote`.
- The first cell holds the row's link; the rest of the row isn't clickable.
- Below 735 px the table scrolls sideways in a region with `tabIndex={0}`, `role="region"` and `aria-labelledby` set to the caption, and the first column is sticky (horizontally, inside that region). Data tables are exempt from reflow (WCAG 1.4.10).
- Loading shows five skeleton rows; empty shows an empty state inside the card; an error shows a danger banner with "Retry".

### 9.23 Charts and stat tiles (admin)

**Chart frame.** A card (`surface`, `rounded-lg`, `elevation-1`, 20 or 24 px padding). The header has a `text-headline` title, an optional `text-footnote text-label-secondary` description, and a legend at the top right when there are two or more series. The plot is 240 px tall on phone and 280 px from 735 px. The SVG gets `role="img"` and an `aria-label` summary ("Units sold per minute, last 30 minutes, peak 140 at 7:02 PM"), followed by a visually hidden `<table>` of the same data (SD §9).

**Recharts settings.**

| Element | Setting |
|---|---|
| Grid | `CartesianGrid vertical={false} stroke="var(--color-chart-grid)"`, solid 1 px |
| Axes | `axisLine={false} tickLine={false}`, ticks `text-caption` in `label-secondary`, `tabular-nums` on the chart wrapper |
| Lines | `strokeWidth={2}`, `type="monotone"`, `dot={false}`, `activeDot` radius 4 with a 2 px `surface` ring |
| Areas | The series colour at `fillOpacity={0.1}` |
| Bars | `maxBarSize={24}`, radius 4 at the data end and square at the baseline, at least 2 px between adjacent bars |
| Tooltip | Custom: `material-thick`, `rounded-md`, `elevation-2`, 8 × 12 px padding, `text-footnote` in `label` (§2.5), 8 px series dots, values `tabular-nums`. Cursor stroke `separator` |
| Legend | Only for two or more series: 8 px dots + `text-footnote` labels. Text is never in the series colour |
| Animation | `isAnimationActive={false}` on every live chart, which updates up to 10 times a second |

**Stat tile.** A card (`surface`, `rounded-lg`, `elevation-1`, 16 or 20 px padding): a label (`text-footnote text-label-secondary`, sentence case, no colon), the value (`text-title-1 tabular-nums`, updating in place without animation), an optional sub-line (`text-footnote text-label-secondary`, such as "of 500 units") and, for health tiles, a status pill at the top right. Money of $10,000 or more shows compact ("$62.2K") with the exact amount in the sub-line ("$62,178.00 gross", §3.3), so the value fits a two-column tile at 320 px; counts compact from 10,000 the same way.

### 9.24 Status pill

24 px tall, 10 px horizontal padding (8 on the icon side), `rounded-full`, `text-caption font-medium`, a 14 px icon with a 4 px gap. Tones: neutral (`fill-tertiary`, `label`), info (`accent-tint`, `accent-label`), success, warning and danger (tint background, base colour text), and live (the LIVE badge, §9.11).

| Domain | Value | Tone | Icon | Label |
|---|---|---|---|---|
| Order | `RESERVED` | info | `Timer` | Reserved |
| Order | `PENDING_PAYMENT` | info | `CircleDashed` | Processing |
| Order | `PAID` | success | `CircleCheck` | Paid |
| Order | `PAYMENT_FAILED` | danger | `CircleX` | Declined |
| Order | `EXPIRED` | neutral | `Hourglass` | Expired |
| Order | `CANCELLED` | neutral | `Ban` | Cancelled |
| Order | `REJECTED` | neutral | `CircleMinus` | Not reserved |
| Drop | `DRAFT` | neutral | `Pencil` | Draft |
| Drop | `SCHEDULED` | info | `CalendarClock` | Scheduled |
| Drop | `LIVE` | live | dot | Live |
| Drop | `PAUSED` | warning | `CirclePause` | Paused |
| Drop | `ENDED` | neutral | `CircleStop` | Ended |
| Drop (Redis) | `RECONCILING` | warning | `RotateCw` | Rebuilding |
| Listing job | `PENDING` | neutral | `Clock` | Queued |
| Listing job | `RUNNING` | info | `CircleDashed` | Generating |
| Listing job | `READY` | success | `CircleCheck` | Ready for review |
| Listing job | `NEEDS_REVIEW` | warning | `TriangleAlert` | Needs review |
| Listing job | `FAILED` | danger | `CircleX` | Failed |
| Listing job | `APPROVED` | success | `CircleCheck` | Published |
| Health, invariant | pass | success | `CircleCheck` | Healthy / Holds |
| Health | over the warning threshold | warning | `TriangleAlert` | Degraded |
| Health, invariant | fail | danger | `CircleX` | Failing / Breached |
| Listing field | AI-generated | neutral | `Sparkles` | AI |
| Listing field | edited by the admin | neutral | `Pencil` | Edited |

Pills are text, not controls. Buyer-facing views show `PAYMENT_FAILED` with the decline code `reference_closed` as the `EXPIRED` pill, because the payment window closed and no card was declined (§10.5).

### 9.25 Small parts

- **Avatar.** A circle, 28 px (navigation) or 40 px (login), `fill-tertiary`, initials in `text-caption` or `text-headline` at 600. No photos. As a link it sits centred in a 44 × 44 px hit area (§9.18).
- **Skip link.** The first focusable element on every page: "Skip to content", or "Skip to checkout" on checkout (SD §8.3). Visually hidden until focused, then a filled sm button 8 px from the top-left at `z-(--z-skip-link)`.
- **Visually hidden text.** Tailwind's `sr-only`.
- **Spinner.** `LoaderCircle` with `animate-spin`, 16 or 20 px, `currentColor`, `aria-hidden`; the busy state is announced by the control or region that owns it.

### 9.26 Steps

Progress through a fixed sequence: the order (Reserved, Payment, Paid) and a listing job (Uploaded, Generating, Review).

```
 ✓ ─────────── ◎ ─────────── ○            horizontal from 735 px; vertical on phone, 24 px between steps
 Reserved      Payment       Paid         footnote
```

- An `<ol>`. Each `<li>` has a 16 px marker slot and a `text-footnote` label: `label` for done and current steps, `label-secondary` for upcoming ones.
- Markers: **done** is `CircleCheck` 16 in `label`. **Current** is a 12 px ring with a 2 px `accent` border, or `LoaderCircle` 16 with `animate-spin` in `accent-label` while the step is running (payment processing, generating). **Upcoming** is a 12 px ring with a 1 px `control` border. The shapes differ, so colour is never the only signal.
- Connectors are 2 px `separator` lines between markers (`flex-1` when horizontal), `aria-hidden`.
- The current step has `aria-current="step"`; each done step ends with a visually hidden ", done".
- Steps show only while the sequence can still finish or after it finished well. An order that ended unpaid (`PAYMENT_FAILED`, `EXPIRED`, `CANCELLED`, `REJECTED`) and a `FAILED` listing job hide them; the heading or banner says what happened instead.

### 9.27 Progress bar

- 4 px tall, `rounded-full`, track `fill-secondary`, fill `accent`.
- **Determinate** (photo upload): the fill's width is the value, updated without a transition (upload events arrive many times a second). `role="progressbar"` with `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow` and `aria-labelledby` pointing at the visible text ("Uploading… 64%").
- **Hold** (checkout): the same bar, stepping once per second, fill `warning` in the last 60 s. It is `aria-hidden="true"`: the countdown has its own four announcements (SD §8.3), and a `progressbar` role would make screen readers report it every second.
- **Indeterminate** (listing generation): a 40% wide fill inside a track with `overflow-clip`, running `motion-safe:animate-indeterminate` (§6.4). `role="progressbar"` without `aria-valuenow`, labelled by the status text. Under reduced motion the bar isn't rendered (`motion-reduce:hidden`), and the status text and the step spinner carry the state.

### 9.28 Chip input

Used for listing tags.

- A field container like §9.4 (label always raised, 1 px `control` border, `rounded-md`, at least 56 px tall) holding a wrapping `<ul>` of chips, 6 px apart, then a text input that takes the remaining width.
- Chip: 28 px tall, `rounded-full`, `fill-tertiary`, the tag in `text-footnote` and `label`, 10 px padding before the text and 2 px after the remove button. The remove button is a 24 px circle (plain icon button with `X` 14), labelled "Remove tag {name}".
- Enter or a comma adds the input's text as a chip; Backspace in an empty input removes the last chip. Each change is announced politely ("Added tag {name}.", "Removed tag {name}."), and focus stays in the input. At the limit (10) the input is `aria-disabled` and the helper text reads "10 of 10 tags".

### 9.29 Page dots

- Under the phone gallery carousel only: 8 px dots, 8 px apart, centred 12 px below the photo. The current dot is `label`, the others `label-tertiary`.
- `aria-hidden="true"`. The slides' labels ("2 of 4") carry the position, and the dots aren't controls.

### 9.30 Key-value list

- A `<dl>`; each row is a `<div>` holding `<dt>` and `<dd>`, at least 44 px tall, `flex items-baseline justify-between gap-4`, with `separator` hairlines between rows.
- `text-callout`: the key in `label-secondary`, the value in `label`, end-aligned. Values wrap and are never truncated; numbers use `tabular-nums`. A row without a value is left out.
- Used for order details, product details (`text-body` there), drop settings and the listing's Generation details.

---

## 10. Page blueprints

Every page has a skip link, one `h1`, the landmarks `header` (navigation), `main` and `footer` (where present), and a unique `<title>` in the form "{Page} · FlashDrop". Route groups and layouts are in §8.1.

### 10.0 Shared route states

These apply on every route, so no blueprint repeats them.

```
                 (icon 40, label-tertiary)
                    Page not found                      title-1, h1
           This link may be old or mistyped.            callout, label-secondary
                    [ Go to drops ]                     md tinted pill
```

| State | Where | Icon | Heading (`h1`) / text | Action |
|---|---|---|---|---|
| Not found | `app/not-found.tsx`, for every 404: unknown URLs, products, drops, jobs and rooms, and other users' orders (`api` answers 404 for them, SD §11) | `Link2Off` | "Page not found" / "This link may be old or mistyped." | Tinted md "Go to drops" link to `/` |
| Error | The `error.tsx` of each area (§8.1), inside that area's chrome | `CircleX` | "Something went wrong" / "Try again in a moment." | Tinted md "Try again", which calls the `retry` prop. In Next 16.3.8 it runs `router.refresh()` and `reset()` in one transition, so server data is fetched again; `reset()` alone would re-render the same failure |
| Signed out | Any 401 from `api`, on the server or in the browser | n/a | n/a | Redirect to `/login?returnTo=<current path>` |

- Both pages use the empty-state layout (§9.17) with the heading promoted to the page's `h1` in `text-title-1`, centred in `page-form` with `py-(--section-space)`. Their `<title>` is "Page not found · FlashDrop" or "Error · FlashDrop".
- The not-found page renders the store navigation bar and footer itself, because it sits outside the route groups.

### 10.1 Home `/`

Rendering per SD §8.1 (request time, then cached under the `drops` tag).

```
┌ navigation bar ───────────────────────────────────────────────────────────────┐
├──────────────── hero: full-bleed bg-secondary, py-(--section-space) ──────────┤
│                            [LIVE]  1,284 watching                             │  centred column
│                                Aurora Runner 2                                │  display-1 (title length rule below), 16 px below
│           Featherlight knit, a carbon plate and exactly 500 pairs.            │  intro, label-secondary, max-w-text
│                [ Buy · lg filled ]  [ Watch live · lg tinted ]                │  24 px above, 12 px gap
│                       Only 12 left · 488 of 500 claimed                       │  LiveStock compact, meter md (360 px)
│                     ┌───────────────────────────────────┐                     │  48 px above
│                     │    hero photo, 1:1, rounded-xl    │                     │  page-form (600 px) from 735 px; 4:5 on phone
│                     │       object-cover, preload       │                     │
│                     └───────────────────────────────────┘                     │
├───────────────────────────────────────────────────────────────────────────────┤
│  Upcoming drops                                                               │  title-1, page-wide
│  ┌ tile ┐  ┌ tile ┐  ┌ tile ┐                                                 │  1 / 2 / 3 columns
├───────────────────────────────────────────────────────────────────────────────┤
└ footer ───────────────────────────────────────────────────────────────────────┘
```

- **Hero choice:** the LIVE drop that started first; otherwise the next SCHEDULED drop; otherwise the empty hero ("No drops right now" in `text-display-2`, icon-free).
- **Headline size** follows the product title's length, because titles run from 10 to 80 characters (SD §10): up to 24 characters `text-display-1`, 25 to 40 `text-display-2`, longer `text-title-1`. Titles are never truncated. This keeps the photo's top edge above the fold at 1440 × 900 and 390 × 844 (§1.2).
- **Hero photo:** one `<Image fill preload>` in a box with `aspect-4/5 sm:aspect-square rounded-xl overflow-clip`, `object-cover` and centred, inside `page-form` from 735 px and the page margins on phone. The seed and generated photos are single 4:5 images with the product at most 80% of the short side (§11.2), so the square crop from 735 px keeps the whole product. A single `<Image>` is what makes the preload work (§11.4).
- **Live hero CTAs:** "Buy" links to `/p/[slug]`, where the reserve flow lives; "Watch live" links to `/live/[roomSlug]` and appears only if the drop has a room.
- **Scheduled hero:** the status line becomes `CalendarClock` + the start as `<LocalTime>` ("Today at 7:00 PM"). Under 24 hours the CTA row is a hero countdown ("Starts in" + `text-title-2` digits) and a filled "View drop" link; from 24 hours it is the "View drop" link alone, because the status line already says when (§9.10). No meter.
- **Tiles:** other LIVE drops first, then SCHEDULED by start time, at most 9.
- **Loading and errors:** the hero and tiles have exact skeletons. If `api` fails at request time, the `(store)` error state renders (§10.0).

### 10.2 Product `/p/[slug]`

```
desktop (page-wide, 12 columns)
┌ gallery: columns 1–7 ─────────────────────────┐ ┌ purchase panel: columns 8–12, sticky ───┐
│                                               │ │ [LIVE]  Ends in 12:04                   │ footnote
│            main photo, 4:5, rounded-lg        │ │ Aurora Runner 2                         │ title-1 (h1)
│                                               │ │ $129                                    │ Price lg
│                                               │ │ Only 12 left        488 of 500 claimed  │ LiveStock, meter md
│                                               │ │ ███████████████████████████████░░       │
│ [▢][▢][▢][▢]  thumbnails 64 px, 8 px gap      │ │ ( − 1 + )  [          Buy           ]   │ stepper + lg filled
└───────────────────────────────────────────────┘ │ Limit 2 per person. We hold your item   │ footnote
                                                  │ for 2 minutes at checkout.              │
                                                  │ Watch the live drop (ChevronRight)      │ plain link, if a room exists
                                                  └─────────────────────────────────────────┘
details section (page-content, separator above, py-(--section-space))
  Highlights            check list, body, max-w-text
  Description           body, max-w-text
  Details               key-value list (§9.30): Brand, Colour, Material, Size, Condition, Category
  Photo: Name on Unsplash        footnote, label-secondary (credit, §11)
```

- **Which drop.** The panel shows the product's current drop: the LIVE or PAUSED one, otherwise the next SCHEDULED one, otherwise the most recent ENDED one (LiveStock's "Drop ended" state).
- **No drop.** A product with no armed drop (for example right after a listing is approved) shows the title, photos and details but no price, stock, stepper or Buy. In their place is the footnote "This product isn't in a drop yet." (`text-label-secondary`). Admins also get a tinted md "Create drop" link to `/admin/drops?new=<productId>`, which opens the New drop sheet with the product chosen (§10.8). The sticky buy bar isn't rendered.
- The panel is sticky at `top: calc(var(--nav-height) + 24px)`. Its blocks are 8 px apart, with 24 px before the stepper row.
- Tablet: two equal columns (4 + 4 on the 8-column grid), panel not sticky.
- Phone: the gallery is a full-bleed 4:5 carousel (CSS scroll snap, one photo per view) with page dots 12 px below it (§9.29); then the panel stacked inside the page margins. A **sticky buy bar** (`material-bar`, 72 px plus the bottom safe area, `data-bottom-bar`) shows the price and the stock primary line in `label` on the left (never `danger`; "Only" carries the urgency, §9.9) and an md filled Buy on the right. It appears when the inline Buy button scrolls out of view (IntersectionObserver) and fades in over 200 ms; the `data-bottom-bar` attribute is present only while the bar shows.
- Gallery: thumbnails are buttons ("Show photo 2 of 4") with a 2 px `label` ring on the selected one. The phone carousel uses `aria-roledescription="carousel"`, and each slide `aria-roledescription="slide"` with `aria-label="2 of 4"`. From 1069 px there are 44 px `material-thick` previous and next buttons with `label` icons that appear on hover and on focus.
- The first gallery photo is the page's one `preload` image. The SSR HTML contains the title and the stock number (SD §8.1, `ssr.spec`).

### 10.3 Live room `/live/[slug]`

The whole route renders inside `<div data-theme="dark" data-page="live" class="min-h-dvh">` (the layout in §8.1), navigation bar included; `data-page="live"` paints the root black and makes its scrollbar dark (§8.2). The live room is always dark, like a theatre.

```
desktop (page-wide, 8 + 4)
┌ player: 16:9, rounded-xl ──────────────────────────────┐ ┌ drop card (sticky) ────┐
│ [LIVE] (Eye 1,284)                     16 px inset     │ │ §9.12                  │
│                                                        │ │                        │
│                     video                              │ │                        │
│                                                        │ │                        │
│ (Play Mute)                          (Live CC Full)    │ │                        │
└────────────────────────────────────────────────────────┘ └────────────────────────┘
 Spring Sneaker Drop                                        title-2
 Live now · Captions available                              footnote, label-secondary

phone: the player is full-bleed (no radius, no margins) directly under the bar,
       then the drop card inside the page margins; both fit in the first viewport at 390 × 844.
tablet: the player spans page-wide; the drop card sits below it, max-w-form.
```

- **Overlay:** the LIVE badge (pulsing, §9.11) and the viewer-count pill sit at the top-left with a 16 px inset. That is all; the room has no chat.
- **Controls:** two `material-overlay` capsules, `rounded-full`, 4 px inner padding around 44 px overlay icon buttons (§9.2), so 52 px tall, each 16 px from its bottom corner. No gradient scrim: text and icons sit on the capsule, which keeps white at 6.72:1 over a white frame, and the white focus ring sits on it too. The left capsule holds play/pause and mute (`aria-pressed`); the right holds "Live" (a text button in `text-footnote font-medium`, shown only when the viewer is behind the live edge, with `bg-label/16` on hover and press), captions (`aria-pressed`) and fullscreen. The capsules fade out (200 ms) after 3 s without pointer movement while playing, never while focus is inside the player, and always show while paused. With the badge and the viewer pill they cover under 20% of the video at 390 px wide (§14).
- **Keyboard:** single-key shortcuts fire only while the player container itself has focus (WCAG 2.1.4): Space or K play and pause, M mutes, C toggles captions, F toggles fullscreen. On a focused control inside the player, Space and Enter activate that control and nothing else.
- **Autoplay** is muted and inline (`playsInline muted autoPlay`), with a "Tap to unmute" overlay pill (`VolumeX`) until the first unmute. Captions are off by default; the choice is remembered in `localStorage`. `::cue` sets only `background-color: rgb(0 0 0 / 0.72)` and the sans font family; the browser sizes cues relative to the video (about 5% of its height), so they grow in fullscreen.
- **Fullscreen** requests fullscreen on the player container, so the badges, the capsules and the docked drop card (§9.12) stay visible. Where element fullscreen isn't available (iPhone Safari), the native video fullscreen is used without the overlay.
- **No stream:** the poster with a centred `material-overlay` message (`VideoOff` 20 and `text-callout`), "The stream starts soon." before the drop and "The stream has ended." after it.
- **Playback error** (a fatal hls.js error, or a native `error` event after one automatic retry): the same overlay message reading "The stream can't play right now." with a filled md "Retry" button under it, which reloads the source. The drop card keeps working, because buying doesn't depend on the video.

### 10.4 Checkout `/checkout/[orderId]`

`canvas` background (`data-page="grouped"` on the layout, §8.1), the reduced navigation bar (§9.18), no footer, one column in `page-form`. The page renders only a `RESERVED` order: for any other status the server redirects to `/orders/[orderId]`, which shows what happened (§10.5).

```
[Skip to checkout]
Checkout                                                           title-1, h1, tabIndex -1, focused on load

┌ hold card (surface, rounded-lg, elevation-1, padding 20 / 24) ─────────────┐
│ Timer  Reserved for you                                     1:47           │ headline · title-2 tabular, aria-hidden
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░                                       │ 4 px bar, steps each second
│ We hold it until 7:04 PM.                                                  │ footnote, label-secondary
│ ─────────────────────────────────────────────────────────────────────────  │ only at ≤ 60 s, once:
│ Need more time?                                         [ Add 1 minute ]   │ callout · sm tinted
└────────────────────────────────────────────────────────────────────────────┘
┌ summary card ──────────────────────────────────────────────────────────────┐
│ ┌────┐  Aurora Runner 2                                  Qty 2   $258.00   │ thumb 64, rounded-sm
│ └────┘  $129.00 each                                                       │
│ ─────────────────────────────────────────────────────────────────────────  │
│ Total                                                            $258.00   │ Price total
└────────────────────────────────────────────────────────────────────────────┘
<form id="checkout-form">
  [error summary: danger banner, role="alert", focus target, a link per field]
  Shipping                                                         legend, title-3
    Full name                          autocomplete="shipping name"
    Address                            autocomplete="shipping address-line1"
    Apartment, suite (optional)        autocomplete="shipping address-line2"
    City            | State            "shipping address-level2" | "shipping address-level1"  (two columns from 735 px)
    ZIP code        | Country          "shipping postal-code" (inputMode numeric) | "shipping country" (select)
  Payment                                                          legend, title-3
    (•) Test card that approves        Always succeeds.            radio card (pm_ok)
    ( ) Test card that declines        Always declined, so you can see what happens.   (pm_decline)
  [                          Pay $258.00                          ]   lg filled rounded, full width
  This is a demo store. No real payment is taken.                      footnote, centred
</form>
```

- Spacing: 32 px between the `h1`, the hold card, the summary card and the form; fieldsets 40 px apart; 24 px above Pay.
- **Countdown** (SD §8.3): the visible `m:ss` and the hold bar (§9.27) use `label` and `accent` until 60 s are left, then `warning`. The UI ends 2 s early. A visually hidden polite region announces only at 2:00, 1:00, 0:30 and 0:10 (§12.2).
- **Extension:** at 60 s left, if `extensions = 0`, the hold card shows the "Need more time?" row. "Add 1 minute" calls `POST /orders/:orderId/extend`; on 200 the row becomes `CircleCheck` + "1 minute added" in `success`, a polite announcement repeats it, and the bar rescales. On 409 (the hold changed meanwhile) the row becomes "Couldn't add time. Your hold ends at {LocalTime}." in `text-callout text-label-secondary`, announced politely, and the countdown continues. The offer appears once.
- **Submit:** Pay shows the spinner and "Processing…" with `aria-busy` and `aria-disabled`, never `disabled` (SD §8.3). The checkout key is created once and kept per SD §8.2.
- **Validation:** on submit, client-side checks first. With errors, the error summary ("Fix 2 fields to continue") appears at the top of the form and takes focus; each link moves focus to its field. Fields show their errors per §9.4.

| Outcome | UI |
|---|---|
| 202 | Navigate to `/orders/[orderId]` |
| 200 replay | Same as 202 |
| 409 `ALREADY_SUBMITTED` | Navigate to `/orders/[orderId]`, toast "This order was already placed." |
| 410 `RESERVATION_EXPIRED` | The expired panel |
| 422 | Error summary with the server's field issues |
| Network error or 5xx | Danger banner above Pay: "Couldn't place your order. Check your connection and try again." Pay retries with the same key |

- **Expired panel:** at expiry (or a 410) the hold card and the form are replaced by one card: `Hourglass` 40 in a 72 px `fill-tertiary` circle, "Reservation expired" (`text-title-2`, `role="alert"`, focused), "Your item went back on sale." and a filled lg "Try again" link to `/p/[slug]` (SD §8.3).
- **Leave checkout:** the alert dialog (§9.14) with "Leave checkout?", "Your reservation will be released.", **Stay** (filled, initial focus) and **Leave** (plain, destructive tone), which calls cancel and then navigates to `/p/[slug]`. If cancel answers 409 (the order was placed or expired in the meantime), the dialog closes and the page navigates to `/orders/[orderId]`.
- `noindex`.

### 10.5 Order status `/orders/[orderId]`

`canvas` (`data-page="grouped"`), `page-form`, the standard navigation bar and footer.

```
                 ( icon 40 in a 72 px tinted circle )
                     Processing payment…                    display-2, h1, tabIndex -1, focused on load
               This usually takes a few seconds.            body, label-secondary
     Reserved ──────────── Payment ──────────── Paid        steps (§9.26): horizontal from 735 px, vertical on phone
┌ details card ──────────────────────────────────────────┐
│ Order                              3F2A9C1B  [copy]     │ key-value list (§9.30), one column
│ Item                                Aurora Runner 2     │
│ Quantity                                          2     │
│ Total                                       $258.00     │
│ Ship to         Mira Chen, 1 Main St, Springfield,      │ long values wrap, end-aligned
│                                         IL 62701        │
│ Payment                     Test card that approves     │
│ Placed                             Today at 7:03 PM     │
└─────────────────────────────────────────────────────────┘
[ action per status ]
```

| Status | Icon and tone | Heading | Text | Action |
|---|---|---|---|---|
| `PENDING_PAYMENT` | Spinner, info | Processing payment… | This usually takes a few seconds. | None |
| `PAID` | `CircleCheck`, success, `celebrate` | You got it. | Your order is confirmed and paid. | Plain link "Back to drops" |
| `PAYMENT_FAILED` | `CircleX`, danger | Payment declined | Your test card was declined, so we released your reservation. | Filled "Back to the drop" |
| `PAYMENT_FAILED`, decline code `reference_closed` | `Hourglass`, neutral | Payment didn't finish in time | We couldn't confirm your payment in time, so we released your reservation. Any charge is refunded. | Filled "Back to the drop" |
| `EXPIRED` before checkout | `Hourglass`, neutral | Reservation expired | The hold ended before checkout was finished. | Filled "Back to the drop" |
| `EXPIRED` after checkout was submitted (the order has shipping and a payment method) | `Hourglass`, neutral | Payment didn't finish in time | We couldn't confirm your payment in time, so we released your reservation. Any charge is refunded. | Filled "Back to the drop" |
| `CANCELLED` | `Ban`, neutral | Order cancelled | You left checkout, so we released your reservation. | Filled "Back to the drop" |
| `REJECTED` | `CircleMinus`, neutral | Not reserved | Reason text from §12.2 | Filled "Back to the drop" |
| `RESERVED` | n/a | n/a | n/a | Redirect to `/checkout/[orderId]` |

- Updates arrive on the `user` topic, with a 2 s poll while `PENDING_PAYMENT` (SD §8.1). On a change, the heading and text change in place, the icon crossfades and the Announcer politely reads the new heading. Focus doesn't move.
- The details list leaves out rows without a value, such as Ship to and Payment on an order that expired before checkout.
- The order id shows its first 8 hex characters, uppercase. Copy (an icon button, "Copy order id") copies the full id and toasts "Order id copied."

### 10.6 Login `/login`

```
canvas, centred card (surface, rounded-xl, elevation-1, padding 24 / 32, page-form)
  Sign in                                                        title-1, h1
  Development sign-in. Pick a seeded account; there's no password.   body, label-secondary
  ┌ (•) (MC)  Mira Chen                                [Admin]  ┐   radio cards, 8 px apart
  │          mira@example.test                                  │   avatar 40, name body 500, email footnote
  └─────────────────────────────────────────────────────────────┘
  ┌ ( ) (AB)  Ada Buyer                                         ┐
  ...
  [                         Continue                         ]   lg filled rounded, full width
  Sessions last 12 hours.                                        footnote, label-secondary
```

- `data-page="grouped"`. Signed out, the `h1` and `<title>` are "Sign in".
- **Signed in,** the page is the account page: the `h1` and `<title>` become "Account", and the top of the card shows "Signed in as {name}" with a plain "Sign out" button and, for admins, an "Open admin" link ending in `ChevronRight`. Choosing another account and Continue switches user.
- **Your orders.** Signed in, a second card follows 24 px below (same card style): a `text-title-3` heading "Your orders" and the latest 10 orders from `GET /me/orders`, newest first. Each row is one link to `/orders/[orderId]`, at least 64 px tall: a 40 px `rounded-sm` thumbnail, the title (`text-callout font-medium`, `line-clamp-2`) over the date (`<LocalTime>`, `text-footnote text-label-secondary`), the status pill (§9.24) and a `ChevronRight` 16 in `label-tertiary`. Rows are separated by `separator` hairlines. With no orders the card shows "No orders yet" / "Orders you place show up here." This is the way back to an order once its page is closed; there is no separate `/orders` route (SD §8.1).
- After sign-in: navigate to `returnTo` if it is a same-origin path, otherwise `/`.

### 10.7 Admin shell

```
≥ 1069 px
┌ navigation bar (page-full) ─────────────────────────────────────────── (MC)   ┐
├ sidebar 240 px, sticky, canvas ┬ content: canvas, page-full ──────────────────┤
│  Layers      Drops              │  Large title                      [Action]  │
│  Sparkles    New listing        │                                             │
│  HeartPulse  Health             │                                             │
│  ─────────                      │                                             │
│  ArrowUpRight  Storefront       │                                             │
└─────────────────────────────────┴─────────────────────────────────────────────┘
< 1069 px: the sidebar becomes a horizontal row of the same links under the bar (scrolls sideways).
```

- The layout sets `data-page="grouped"` (§8.1), so the page and the sidebar sit on `canvas`.
- Sidebar items: 36 px tall, `rounded-md`, 12 px padding, a 20 px icon and `text-callout`. Current (`aria-current="page"`): `fill-tertiary` and `font-semibold`. Hover: `fill-quaternary`.
- Admin pages use the large title (§9.19). Page actions sit at the top right of the title row: one filled, the rest gray.

### 10.8 Admin drops `/admin/drops` and `/admin/drops/[dropId]`

**List.**

- Large title "Drops" with a filled md "New drop". Below it an md segmented control: All, Live, Scheduled, Draft, Ended.
- Table columns: Product (40 px `rounded-sm` thumb, title, slug in `text-footnote font-mono`), Status (pill), Window ("Oct 6, 7:00–7:30 PM"), Price, Stock (sm meter 64 px wide + "488/500"), Limit, then a `ChevronRight` cell. The product cell links to the detail page.
- "New drop" opens a sheet (§9.14) with Product (select), Room (select, optional), Starts and Ends (`datetime-local`), Price (text field with a "$" prefix, `inputMode="decimal"`), Total units, Limit per person (1–10), Hold seconds (default 120), Payment seconds (default 300), and a filled "Create draft". `/admin/drops?new=<productId>` opens the same sheet with that product chosen (the product page's "Create drop" link, §10.2).

**Detail.**

- Title row: 56 px thumb, the product title (`text-title-1`), status pill. Actions depend on status, at most three. The API decides which transitions are legal (SD §5.1); the UI shows only those:

| Status | Actions |
|---|---|
| `DRAFT` | Filled "Arm drop", gray "Edit" |
| `SCHEDULED` | Gray "Reconcile" |
| `LIVE` | Gray "Pause", gray "Reconcile", destructive tinted "End drop" |
| `PAUSED` | Filled "Resume", gray "Reconcile", destructive tinted "End drop" |
| `ENDED` | Gray "Reconcile" while the drop is still tracked |

- "Arm drop", "End drop" and "Reconcile" confirm in an alert dialog (§12.2). Arming fixes the stock, limit, windows and schedule for good (SD §4.7), so its dialog says so: "Arm this drop?" / "You can't edit it after arming. It opens {LocalTime}." ("It opens Tue, Oct 6 at 7:00 PM.") / filled "Arm drop", gray "Cancel". 409 `DROP_ARMED` and `DROP_BUSY` show a warning banner (§12.2).
- "Edit" (DRAFT only) opens the New drop sheet prefilled with the drop's values, titled "Edit drop", with a filled "Save changes" (`PATCH /admin/drops/:id`).
- Body at desktop, 8 + 4. Left: a Live stock card (lg meter with a legend: Available, In carts, Sold, Total, all `tabular-nums`) and a Settings card (a key-value list, §9.30). Right: a Links card: "View product page" and "Open live room" ending in `ArrowUpRight`, "Open dashboard" ending in `ChevronRight` (§7).

### 10.9 Listing generator `/admin/listings/new` and `/admin/listings/[jobId]`

**New listing.**

```
New listing                                                              large title
Upload 1–4 photos. We draft the listing; you review it before anything is published.   body, label-secondary
┌ dropzone: rounded-lg, 2 px dashed control border, surface, min-height 240 ────────────┐
│                         ImageUp 40, label-tertiary                                    │
│                 Drag photos here or [ Choose photos ] (md tinted)                     │
│          JPEG, PNG or WebP · up to 8 MB each · 1 to 4 photos (footnote, secondary)    │
└───────────────────────────────────────────────────────────────────────────────────────┘
[▢ ×] [▢ ×] [▢ ×]          120 px square thumbs, rounded-md, 32 px gray Trash icon button at the top-right corner
Notes for the generator (optional)                         textarea, counter 0/500
For example the size, or what's in the box. Treated as hints, not instructions.   helper
[ Generate listing ]                                        lg filled, aria-disabled until one photo is chosen
```

- The "Choose photos" button is the primary path; drag and drop is extra (WCAG 2.5.7). The dropzone's dashed border turns `accent` while a file is dragged over it.
- Client-side checks before upload (MIME type and extension, at most 8 MB, 1 to 4 files) mirror the server, which stays authoritative (SD §10). Each rejected file gets its own error ("photo.heic isn't a JPEG, PNG or WebP.", "photo.jpg is larger than 8 MB.").
- Thumbs before upload are plain `<img>` elements on object URLs, not `next/image`; remove buttons are labelled "Remove photo 2".
- Upload progress uses `XMLHttpRequest` upload events (fetch has none): Generate shows "Uploading… 64%" and a determinate progress bar (§9.27) sits under the thumbs. On 202, navigate to the job page. A 429 shows a warning banner (§12.2).
- **Server rejection.** A 413 shows "{file} is larger than 8 MB."; a 415 or 422 shows "{file} isn't a JPEG, PNG or WebP." ({file} is the name the server reports, or "A photo" when it names none). The message is a danger banner above Generate, `role="alert"`, and the chosen photos stay so the admin can remove the bad one and try again.

**Job page, generating** (`PENDING`, `RUNNING`): the status pill in the title row; a card with the photos (80 px thumbs) and steps (§9.26: Uploaded done, Generating current with its spinner, Review upcoming); an indeterminate progress bar (§9.27) and "Generating the draft. This usually takes under a minute." Status arrives as `listing{jobId, status}` on the `user` topic with a 3 s poll fallback (SD §10); each change is announced politely.

**Failed:** no steps; a danger banner, "We couldn't generate this listing.", with the reason (§12.2) and a filled "Start over" link to `/admin/listings/new`.

**Review** (`READY`, `NEEDS_REVIEW`):

```
desktop: 5 + 7
┌ photos (sticky) ─────────────┐ ┌ form ──────────────────────────────────────────────────────────┐
│ viewer: 4:5, object-contain  │ │ [warning banner when NEEDS_REVIEW]                             │
│ thumbs 64                    │ │ Fields marked AI were generated from your photos. Review every │
│ ┌ Generation details ──────┐ │ │ field before publishing.          (footnote, once; key-value)  │
│ │ Model  claude-sonnet-5-5 │ │ │ Title [AI]                                            42/80    │
│ │ Prompt v1 · 2 attempts   │ │ │ ┌────────────────────────────────────────────────────────────┐ │
│ │ Tokens 3,412 in · 812 out│ │ │ └────────────────────────────────────────────────────────────┘ │
│ │ Cost   $0.024 · 9.8 s    │ │ │ Description [AI]                                   412/1,200   │
│ └──────────────────────────┘ │ │ Highlights [AI]   3 to 6, each up to 120 characters            │
└──────────────────────────────┘ │   1 [ ......................................... ] [×]          │
                                 │   [+ Add highlight]                                            │
                                 │ Category [AI] (select)            Condition [AI] (select)      │
                                 │ Brand [AI]                                                     │
                                 │ [!] Not visible in the photos. Add it if you know it, or leave │
                                 │     it empty.                                [Looks right]     │
                                 │ Colour [AI]   Material [AI]   Size [AI] (required for apparel) │
                                 │ Tags [AI]   chip input (§9.28), at most 10                     │
                                 └────────────────────────────────────────────────────────────────┘
sticky action bar (material-bar, bottom): "4 fields unchanged · 1 uncertainty open"   [ Approve and publish ]
                                          footnote, label                              md filled
```

- **AI badge:** a neutral 20 px pill ("AI", `Sparkles` 14) after the label of every generated field. When the admin changes the value it becomes "Edited" (`Pencil`), which is the edit-rate metric (SD §10).
- **Uncertainty prompt:** each entry of `uncertainties[]` becomes a `warning-tint` row under its field's label (`rounded-md`, 8 × 12 px padding, `TriangleAlert` 16 in `warning`, `text-callout` in `label`), with a plain sm "Looks right". It disappears when the field is edited or confirmed. Approval is allowed with open uncertainties; the action bar counts them.
- **Issues** (`NEEDS_REVIEW`): the job's `issues` are mapped to fields by path and shown as field errors (§9.4).
- **Client validation** mirrors `ListingDraft` (SD §10): title 10–80 characters, description 80–1,200, 3–6 highlights of at most 120 characters, at most 10 tags, no banned claims, no prices or currency, no all-caps title, the attributes the category requires. Counters show the limits; errors appear on blur and on submit, with an error summary on a failed submit.
- **Approve:** "Publishing…" in flight; on success, navigate to `/p/[slug]` with the toast "Published." The server re-validates (SD §10).
- Model output is always rendered as text, never as HTML.
- **Action bar:** `material-bar`, `z-(--z-sticky)`, 72 px plus the bottom safe area, `data-bottom-bar`. Its count text is `text-footnote text-label` (§2.5), and Approve is the filled button.
- **Approved:** the form becomes a read-only summary with a success banner, "Published on {LocalTime}.", and a "View product page" link ending in `ArrowUpRight`.

### 10.10 Live dashboard `/admin/dashboard/[dropId]`

```
Aurora Runner 2                                                     large title
[LIVE] · Oct 6, 7:00–7:30 PM · ● Live updates          [Pause updates]   (plain sm, aria-pressed)
┌ Units sold ┐ ┌ Sell-through ┐ ┌ GMV ─────────────┐ ┌ Payment failures ┐ ┌ Time to sell-out ┐   stat tiles: 5 columns ≥ 1069,
│ 482        │ │ 96.4%        │ │ $62.2K           │ │ 2.9%             │ │ Not sold out     │   2 on phone (the last spans both)
│ of 500     │ │              │ │ $62,178.00 gross │ │ 15 of 512 placed │ │ 12 left          │
└────────────┘ └──────────────┘ └──────────────────┘ └──────────────────┘ └──────────────────┘
┌ Units sold per minute (area, chart-1) · 8 columns ──────┐ ┌ Stock now · 4 columns ──────┐
│                                                         │ │ lg meter + legend:          │
│                                                         │ │ Available 12 · In carts 6   │
│                                                         │ │ Sold 482 · Total 500        │
└─────────────────────────────────────────────────────────┘ └─────────────────────────────┘
┌ Funnel · 12 columns ───────────────────────────────────────────────────────────────────────┐
│ Reserved ████████████████████ 646   Placed ████████████████ 512   Paid ███████████████ 470 │  horizontal bars, chart-1
│ Expired ███ 111  Cancelled ██ 44  Failed █ 15  Rejected █ 9                                │  chart-muted, values at tips
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Outbox lag ┐ ┌ Consumer lag ────────────┐ ┌ Redis drift ┐ ┌ Dead letters ┐               health tiles with pills
│ 0.4 s      │ │ payment 0 · settlement 0 │ │ 0 units     │ │ 0            │
│ [Healthy]  │ │ dashboard 2  [Healthy]   │ │ [Healthy]   │ │ [Healthy]    │
└────────────┘ └──────────────────────────┘ └─────────────┘ └──────────────┘
Totals are a projection of orders.v1, version 1,204.                     footnote, label-secondary
```

- The first state is server-rendered (SD §9); then the page follows `dash:<dropId>` and `stock:<dropId>`. Numbers swap in place and charts redraw without animation. Nothing is announced.
- "Pause updates" freezes the view (WCAG 2.2.2) and shows "Paused at 7:04:12 PM"; Resume catches up to the latest version. The connection indicator shows a `success` dot and "Live updates", or `WifiOff` and "Updates paused" after 5 s disconnected.
- Each chart has a visually hidden data table (SD §9). Recharts loads dynamically with fixed-height skeletons.

### 10.11 Health `/admin/health`

- Large title "Health", then "Updated 3 s ago" (`text-footnote`) and a plain sm "Pause updates" (`aria-pressed`). It polls `GET /admin/health` every 5 s.
- A summary banner: success "All 9 invariants hold." or danger "2 invariants are failing." with links to the failing rows.
- An invariants card: a table with one row per INV-1 to INV-9 (SD §1.1): id (`font-mono`), name, a status pill (Holds or Breached), a detail line ("reserved + sold ≤ total for 12 drops") and the time it was checked.
- Metric tiles with thresholds that match the alerts in SD §12:

| Tile | Healthy | Degraded | Failing |
|---|---|---|---|
| Outbox lag | < 2 s | 2–10 s | > 10 s |
| Consumer lag, per group | 0, or falling | Rising for over 30 s | A partition stuck for over 5 min |
| Redis drift, per drop | 0 | n/a | ≠ 0 over two stable samples |
| Dead letters | 0 | n/a | > 0 |
| Sweeper quarantine | 0 | n/a | > 0 |
| Drops rebuilding | 0 | Rebuilding < 30 s | Rebuilding > 30 s |

---

## 11. Imagery

### 11.1 Sources and credit

- Seed and demo photos come only from Unsplash (Unsplash License) or Pexels (Pexels License), per the owner's decision of 2026-10-02.
- Each photo's credit (photographer, source and URL) is recorded in a `CREDITS.md` next to the seed images and shown on the product page as "Photo: {Name} on Unsplash" (`text-footnote text-label-secondary`, the name linking to the source). M1 decides where the seed stores the credit string, for example `attributes.photoCredit`. Photos an admin uploads through the listing generator carry no credit line.
- Product names are fictional. No photo may centre on a real brand's logo or trademark.

### 11.2 Content

- One product per photo, centred, on a seamless neutral background (white, light gray from `#f0f0f0` to `#f5f5f7`, or a soft warm gray), with soft even light.
- The product fills 60 to 80% of the frame's shorter side. A product's photos share one angle and light, with the front three-quarter view first.
- No text, watermarks or collages. No person as the main subject.
- Originals are at least 1600 px on the long edge. The upload pipeline caps them at 1568 px (SD §10).
- Photos are shown unchanged in dark mode.

### 11.3 Crops

| Place | Aspect | Fit |
|---|---|---|
| Tile, product gallery | 4:5 | `object-cover`, centred |
| Home hero | 1:1 from 735 px, 4:5 on phone, from the same 4:5 file | `object-cover`, centred (§10.1) |
| Live video and poster | 16:9 | `object-contain` on black |
| Thumbnails (drop card, checkout, admin tables, gallery strip) | 1:1 | `object-cover` |
| Listing review viewer | 4:5 | `object-contain` on `bg-secondary`, so the whole photo shows |

### 11.4 next/image

- Every image has `alt`: `""` where adjacent text names the product (tiles, thumbnails), otherwise "{title}, photo {i} of {n}".
- Every image sets `sizes`:

| Image | `sizes` |
|---|---|
| Tile | `(min-width: 1069px) 384px, (min-width: 735px) calc(50vw - 42px), calc(100vw - 40px)` |
| Gallery main photo | `(min-width: 1069px) 690px, (min-width: 735px) calc(50vw - 42px), 100vw` |
| Home hero | `(min-width: 735px) 600px, calc(100vw - 40px)` |
| Drop card thumb | `72px` |
| Checkout summary thumb, gallery thumbs | `64px` |
| Admin table thumb | `40px` |

- Exactly one image per page has `preload` (Next 16 replaced `priority` with `preload`): the home hero photo on `/` and the first gallery photo on `/p/[slug]`. Every other image lazy-loads (the default).
- The preloaded image is always an `<Image>` element. In Next 16.3.8, `<Image preload>` emits `ReactDOM.preload` with the srcset and sizes, while `getImageProps({ preload: true })` only turns lazy loading off and emits no preload, so `getImageProps` and art-directed `<picture>` are not used for an LCP image.
- `quality` stays at the default 75 (Next 16's `images.qualities` defaults to `[75]`).
- No `placeholder="blur"`. The well's `bg-secondary` is the placeholder.
- **Upload origin.** Product photos are `uploads/<sha256>.jpg`, served by `api`. The optimizer in `web` fetches them from `API_INTERNAL_URL` (`http://api:4000` in Compose, `http://127.0.0.1:4000` in dev). Next 16 refuses private addresses by default (`images.dangerouslyAllowLocalIP: false`), so M1 sets `images.remotePatterns` to exactly that origin with the path `/uploads/**`, sets `dangerouslyAllowLocalIP: true` (safe, because our own `api` is the only allowed origin) and sets `minimumCacheTTL: 31536000`, because the files are content-addressed. Appendix B lists the alternative.
- The live poster is a static JPEG in `public/hls/`, 1280 × 720, at most 80 KB.

---

## 12. Voice and microcopy

### 12.1 Voice

- Clear, direct, warm and brief. Say the thing, then stop.
- Sentence case everywhere: titles, buttons, labels, pills and table headers.
- "You" is the buyer and "we" is FlashDrop. Active voice.
- Numerals for every number ("2 minutes", "Only 3 left"). A real ellipsis character (…) for actions in progress ("Reserving…").
- No exclamation marks. No ALL CAPS (the LIVE badge is CSS). No "Sorry", no "Oops", no "Please" at the start of an instruction.
- Errors say what happened and what to do next, and never blame. Buttons are verbs that say what happens ("Pay $258.00", "Add 1 minute", "Approve and publish").
- Buyers never see system words such as idempotency, Redis, gen, seq or reservation id. Admin screens may use precise technical words.

### 12.2 Strings

**Buying**

| Context | Copy |
|---|---|
| Buy button | Buy · Buy 2 · Sign in to buy · Reserving… · Still trying… · Reserved · Opens at 7:00 PM · Opens Tue, Oct 6 |
| Stock | 488 left (above the urgent threshold) · Only 12 left (at or below it) · 488 of 500 claimed · All reserved · 3 in carts, may free up · 1 in a cart, may free up · Sold out · All 500 sold · Starts in 4:09 · Starts Tue, Oct 6 at 7:00 PM · Paused · Sales are paused. This page updates when they resume. · Drop ended · 482 of 500 sold · Live updates paused |
| Product without a drop | This product isn't in a drop yet. · Create drop (admins) |
| Stock announcements | 10 left. · 5 left. · 1 left. · All reserved. Some may free up. · Sold out. · Available again. 4 left. |
| Limit line | Limit 2 per person. We hold your item for 2 minutes at checkout. · Compact (drop card): Limit 2 per person · Held 2 minutes at checkout |
| `SOLD_OUT` | Sold out. Every unit has been claimed. |
| `LIMIT_REACHED` | You've reached the limit of 2 for this drop. |
| `DROP_NOT_LIVE` | This drop isn't live right now. |
| `RESERVATION_EXPIRED` (reserve replay) | That reservation expired. Try again if any are left. |
| 429 | Too many tries. Wait a moment, then try again. |
| 503 after 10 s | We couldn't reserve right now. Try again. |
| Offline | You're offline. Check your connection and try again. |
| `IDEMPOTENCY_KEY_REUSED` | Something didn't match. Refresh the page and try again. |

**Checkout**

| Context | Copy |
|---|---|
| Hold | Reserved for you · We hold it until 7:04 PM. |
| Extension | Need more time? · Add 1 minute · 1 minute added · Couldn't add time. Your hold ends at 7:04 PM. |
| Announcements | 2 minutes left to check out. · 1 minute left. You can add 1 more minute. (or "1 minute left." once extended) · 30 seconds left. · 10 seconds left. |
| Expired | Reservation expired · Your item went back on sale. · Try again |
| Fields | Full name · Address · Apartment, suite (optional) · City · State · ZIP code · Country |
| Field errors | Enter your full name. · Enter your street address. · Enter your city. · Choose your state. · Enter a 5-digit ZIP code. · Choose a payment method. |
| Error summary | Fix 1 field to continue · Fix 2 fields to continue |
| Payment methods | Test card that approves / Always succeeds. · Test card that declines / Always declined, so you can see what happens. |
| Pay | Pay $258.00 · Processing… |
| Submit failure | Couldn't place your order. Check your connection and try again. |
| Already placed | This order was already placed. |
| Leave dialog | Leave checkout? · Your reservation will be released. · Stay · Leave |
| Footnote | This is a demo store. No real payment is taken. |

**Orders.** The headings and texts are in §10.5. `REJECTED` texts by close reason: `SOLD_OUT` "Every unit was claimed before your reservation went through."; `LIMIT` "You've already claimed the limit for this drop."; `NOT_LIVE` "The drop wasn't open when your request arrived."; `ORPHANED` "Your request didn't finish, so nothing was reserved."

**Account**

| Context | Copy |
|---|---|
| Login | Sign in · Development sign-in. Pick a seeded account; there's no password. · Continue · Sessions last 12 hours. |
| Signed in | Account · Signed in as Mira Chen · Sign out · Open admin |
| Your orders | Your orders · No orders yet / Orders you place show up here. |
| Navigation | Sign in · Account, Mira Chen (avatar label) |

**Shared states and live room**

| Context | Copy |
|---|---|
| Not found | Page not found / This link may be old or mistyped. / Go to drops |
| Error | Something went wrong / Try again in a moment. / Try again |
| Live room, nothing pinned | Nothing on sale right now / The next drop appears here when it's pinned. |
| Player | Tap to unmute · The stream starts soon. · The stream has ended. · The stream can't play right now. · Retry · Live |

**Empty states**

| Screen | Title / text / action |
|---|---|
| Home | No drops right now / New drops show up here. Check back soon. / none |
| Admin drops (filtered) | No live drops / Drops show up here while they're live. / Show all |
| Admin drops (none) | No drops yet / Create a drop from a published product. / New drop |
| Dashboard before any order | No orders yet / Numbers appear as soon as the first buyer reserves. / none |

**Admin**

| Context | Copy |
|---|---|
| Arm drop | Arm this drop? / You can't edit it after arming. It opens Tue, Oct 6 at 7:00 PM. / Arm drop · Cancel |
| Edit drop | Edit drop · Save changes |
| End drop | End this drop now? / Buyers can't reserve after it ends. Reservations already made can still check out. / End drop · Cancel |
| Reconcile | Rebuild live stock? / We'll rebuild this drop's live stock from the database. Buyers may be asked to try again for 1–3 seconds. / Rebuild · Cancel |
| `DROP_ARMED` | This drop is already armed. Refresh to see its current state. |
| `DROP_BUSY` | Another change to this drop is running. Try again in a moment. |
| Listing intro | Upload 1–4 photos. We draft the listing; you review it before anything is published. |
| Listing 429 | You've started 10 listings in the last minute. Try again in a moment. |
| Upload rejected | photo.jpg is larger than 8 MB. · photo.heic isn't a JPEG, PNG or WebP. · A photo isn't a JPEG, PNG or WebP. (no file name from the server) |
| Tags | Remove tag {name} · Added tag {name}. · Removed tag {name}. · 10 of 10 tags |
| Generating | Generating the draft. This usually takes under a minute. |
| Needs review | Some fields need attention. Fix the highlighted fields to publish. |
| Failed: refusal | The model declined these photos (category: {category}). Try different photos. |
| Failed: other | Something went wrong while generating. Start over to try again. |
| AI note | Fields marked AI were generated from your photos. Review every field before publishing. |
| Uncertainty fallback | Not visible in the photos. Add it if you know it, or leave it empty. |
| Approve | Approve and publish · Publishing… · Published. |
| Health | All 9 invariants hold. · 2 invariants are failing. |

---

## 13. Accessibility

Target: WCAG 2.2 AA, enforced by Biome's a11y rules, axe in every checkout state, a keyboard-only purchase and a manual NVDA pass (SD §8.3, §13).

### 13.1 Rules

| Area | Rule |
|---|---|
| Contrast (1.4.3, 1.4.11) | Only the tokens in §2, proven in Appendix A and by `tokens.test.ts`. Text is at least 4.5:1; control boundaries, focus rings and meaningful icons at least 3:1 |
| Colour (1.4.1) | Never the only signal (§2.7). Links in running text are underlined |
| Focus (2.4.7, 2.4.11) | The 3 px ring on everything focusable; never hidden behind sticky bars (scroll padding, §4.5); DOM order equals visual order, so no CSS `order` and no positive `tabIndex` |
| Targets (2.5.8) | At least 24 × 24 px everywhere; 44 × 44 px for md and lg controls (§9.0) |
| Keyboard (2.1.1, 2.1.4) | Everything works with Tab, Shift+Tab, Enter, Space, the arrow keys and Esc. Single-key shortcuts only while the player container itself has focus (§10.3) |
| Dragging (2.5.7) | Every drag has a button alternative: sheets have close, the dropzone has Choose photos |
| Timing (2.2.1, 2.2.2) | Checkout offers the one-time extension (SD §8.3). Auto-updating admin views have "Pause updates". Toasts pause on hover and focus, and hold nothing essential. The LIVE dot stops after 4.8 s (§9.11); the only endless animations are progress indicators |
| Reflow (1.4.10) | Works at 320 px without sideways scrolling, except data tables and charts |
| Text spacing (1.4.12) | No fixed heights on text containers. Reserved heights (LiveStock) use `min-height` |
| Forms (3.3.1, 3.3.2, 3.3.7) | Visible labels, `autocomplete` tokens, errors in text linked with `aria-describedby`, nothing asked twice |
| Authentication (3.3.8) | Dev login needs no password or puzzle |
| Motion (2.3.3, guidance) | §6.5 |
| Names | Icon-only buttons have `aria-label`; toggles use `aria-pressed`; disabled controls use `aria-disabled` |
| Structure | One `h1` per page, headings in order, landmarks (§10), `lang="en"`, unique titles |
| Media (1.2.4) | The live sample has a WebVTT captions track (SD §8.1) and a captions toggle |
| Forced colours | Controls keep 1 px borders, status pills keep icons, focus uses the outline, and materials fall back to system colours |

### 13.2 Focus management

| Moment | Focus goes to |
|---|---|
| Checkout loads | The `h1` (`tabIndex={-1}`) (SD §8.3) |
| Failed submit | The error summary (`role="alert"`) |
| Reservation expires | The "Reservation expired" heading in the expired panel |
| Order page loads after submit | The status heading |
| Dialog opens | The safe action ("Stay", "Cancel"), or the first field of a sheet |
| Dialog closes | The element that opened it |
| Client navigation | Next.js route announcement; the skip link is the first tab stop |
| A pinned drop changes in the live room, live stock changes | Nowhere: focus never moves for live updates |

### 13.3 Live regions

SD §8.3 sets the policy for checkout and stock; this extends it to the whole app.

1. The `Announcer` in the root layout renders two visually hidden regions that are always in the DOM, one polite (`role="status"`) and one assertive (`role="alert"`). `announce(text, politeness)` clears the region and sets the text on the next frame, so a repeated message is read again. Regions are never inserted together with their text.
2. Polite announcements: checkout countdown thresholds at 2:00, 1:00, 0:30 and 0:10 (checkout's own region, SD §8.3); stock events (§9.9); order status changes on the order page; listing job status changes; toasts; "1 minute added" and "Couldn't add time…"; "Now selling: {title}"; tags added and removed (§9.28); "Live updates paused" and "Live updates resumed", once each.
3. Assertive, with focus moved there: reservation expired; the checkout error summary.
4. Never announced: individual stock deltas, viewer counts, countdown ticks, dashboard and health numbers, skeletons being replaced, chart redraws.
5. At most one announcement per 3 s from any one source, and the latest state wins.

---

## 14. Performance

| Area | Rule |
|---|---|
| Core Web Vitals (p75, mid-range phone) | LCP ≤ 2.5 s, CLS ≤ 0.05, INP ≤ 200 ms on `/`, `/p/[slug]`, `/live/[slug]` and `/checkout/[orderId]` |
| LCP | One `preload` image per page (§11.4). No fade or entrance animation on the LCP element. Hero text is server-rendered and never waits for JavaScript |
| Layout shift | Every image has an aspect ratio or dimensions. Skeletons have the final box. LiveStock reserves its height. Banners appear only in reserved slots or after user action. The metric-matched fallback font makes the Inter swap shift-free. `scrollbar-gutter: stable` |
| JavaScript | Storefront routes ≤ 160 KB gzipped first-load JS, read from the `next build` output and recorded in M1. Recharts and hls.js load with `next/dynamic`, only on the routes that use them. `motion` features load after hydration (§8.5) |
| Fonts | 0 bytes on Apple platforms, one 72.9 KB file elsewhere, not preloaded, `font-display: swap`, metric-matched fallback. No other web fonts |
| Live updates | At most 10 frames per second reach React (SD §7 coalescing). Components read the store through `useSyncExternalStore` and re-render only the number that changed. Number motion is skipped above 4 updates per second (§6.4). Charts don't animate |
| Animation | Only `transform` and `opacity` animate (§6.1). `will-change` only while an animation runs. Never animate blur |
| Materials | At most two blurred surfaces visible at once (§2.5). The player overlay covers at most 30% of the video |
| Images | Served through `next/image` in WebP at quality 75, `sizes` always set, content-addressed and cached for a year (§11.4) |
| Clocks | One shared 1 s clock for every countdown (§8.7), stopped while the tab is hidden |

---

## 15. UI review checklist

Every PR that changes `apps/web` UI is reviewed against this list. A screenshot in light and dark at 390 and 1440 px wide goes in the PR description.

- [ ] Only tokens: no hex values, no Tailwind default palette, no arbitrary sizes, spacing, radii or durations (§2.1, §3.2, §4.1, §5, §6.2).
- [ ] Light and dark both checked, plus the forced-dark live room where it applies. No `dark:` colour utilities.
- [ ] One filled button per region; secondary actions are tinted, gray or plain (§1.1, §9.1).
- [ ] Type uses the eleven styles; numbers use `tabular-nums`; money, counts and times go through `lib/format.ts` (§3.3).
- [ ] Layout uses `page-*` containers and the spacing variables; it works at 320, 390, 768, 1024, 1280, 1440 and 1920 px (§4).
- [ ] Every interactive state from §9.0 is present: hover (pointer only), pressed, focus-visible, disabled (`aria-disabled`), loading (`aria-busy`).
- [ ] Targets are at least 44 px for md and lg controls and never under 24 px.
- [ ] Keyboard path works end to end; focus moves as §13.2 says; nothing focused hides under a sticky bar.
- [ ] Live regions follow §13.3: nothing chatty, nothing silent that matters.
- [ ] Transform motion is `motion-safe:` or goes through `motion`; checked with reduced motion on (§6.5).
- [ ] Text on photos or video sits on `material-overlay` and is white; text and icons on `material-bar` and `material-thick` are `label` only, plain buttons included (§2.5).
- [ ] Grouped pages and the live room set `data-page` instead of painting a wrapper; the scrollbar and overscroll match the page in both modes (§8.2).
- [ ] Images: right crop and aspect, `alt`, `sizes`, one `preload` per page, credit shown for stock photos (§11).
- [ ] Copy matches §12: sentence case, no exclamation marks, errors say what to do next.
- [ ] Skeletons match final sizes; no layout shift on load or on live updates (§14).
- [ ] No new UI dependency without a row in §8.6.
- [ ] axe reports 0 serious or critical violations in the states the change touches (SD §13).

---

## Appendix A. Contrast proof

Computed on 2026-10-02 with WCAG 2.x relative luminance. Translucent colours are composited over each background listed, and the worst result is shown. "Surfaces" means `bg`, `bg-secondary`, `surface` and `surface-raised` in that mode. "Worst content" means black behind a light material, white behind a dark material and a white video frame behind `material-overlay`; the material is composited over it first. `tokens.test.ts` (§8.8) recomputes this table.

| Pair | Light, worst | Dark, worst | Needed |
|---|---|---|---|
| `label` on surfaces | 15.46 | 12.80 | 4.5 |
| `label-secondary` on surfaces | 4.66 | 5.42 | 4.5 |
| `label-tertiary` on surfaces (non-text) | 3.33 | 3.35 | 3.0 |
| `control` on surfaces | 3.33 | 3.35 | 3.0 |
| `accent-label` on surfaces | 5.62 | 4.92 | 4.5 |
| `accent-label` on `accent-tint` / `accent-tint-hover` (over `bg`, `bg-secondary`, `surface`) | 4.79 / 4.53 | 4.87 / 4.54 | 4.5 |
| `label-on-color` on `accent` / `accent-hover` / `accent-pressed` | 4.70 / 5.57 / 6.59 | same | 4.5 |
| `label-on-color` on `live` | 4.84 | 4.84 | 4.5 |
| `success` / `warning` / `danger` on surfaces | 5.46 / 5.49 / 5.75 | 6.89 / 6.78 / 4.94 | 4.5 |
| `success` / `warning` / `danger` on their own tint (over `bg`, `bg-secondary`, `surface`) | 4.99 / 5.03 / 4.92 | 6.21 / 6.10 / 5.03 | 4.5 |
| `danger` on `danger-tint-hover` (over `bg`, `bg-secondary`, `surface`) | 4.67 | 4.75 | 4.5 |
| `label` on `fill-tertiary` (neutral pill, segmented control, gray button, chip) | 13.48 | 9.81 | 4.5 |
| `label` on `thumb` | 16.83 | 5.50 | 4.5 |
| `focus` on surfaces | 5.62 | 4.92 | 3.0 |
| `label` on `material-bar`, worst content | 10.15 | 8.85 | 4.5 |
| `label` at 80% on `material-bar`, worst content (navigation links) | 6.30 | 6.37 | 4.5 |
| `label` on `material-thick`, worst content | 12.19 | 8.18 | 4.5 |
| `label` on `fill-tertiary` on `material-bar` / `material-thick`, worst content (gray buttons on bars, toast action) | 9.16 / 10.83 | 7.33 / 6.90 | 4.5 |
| `focus` on `material-bar` / `material-thick`, worst content | 3.69 / 4.43 | 3.40 / 3.15 | 3.0 |
| Toast status icons (`success`, `warning`, `danger`, `accent-label`) on `material-thick`, worst content (non-text) | 4.31 | 3.15 | 3.0 |
| White / white 80% on `material-overlay`, worst content | 6.72 / 5.01 | same | 4.5 |
| White on `label/16` over `material-overlay`, worst content (overlay hover, the player's "Live" button) | 4.56 | same | 4.5 |
| White icon on `label/24` over `material-overlay`, worst content (overlay icon button pressed, non-text) | 3.80 | same | 3.0 |
| White focus ring on `material-overlay`, worst content | 6.72 | same | 3.0 |

Known limits, handled by rules rather than by colour:

- `label-secondary`, `accent-label` and the status colours on `material-bar` or `material-thick` fall to between 3.06 and 4.77:1 over the worst content, so text and icons there are `label` only (§2.5). The one exception, the toast status icon, is proven above as non-text.
- `danger` on `material-overlay` is 2.38:1, so urgent stock on video is white and the word "Only" carries it (§9.9).
- `live` as a bare dot is 2.88:1 on `surface-raised` in dark mode and 2.92 / 1.99:1 on `material-bar`, so the dot always sits next to the word "Live".
- `accent-label` against `label` text is 2.75 / 2.60:1, so links in running text are underlined (§2.7).
- A disabled control's label (`label-tertiary` on `fill-tertiary`) is 2.90 / 2.57:1. WCAG 1.4.3 exempts inactive controls, and LiveStock always repeats the state ("Sold out", "Starts in 4:09") in `label` beside the button (§2.3, §9.9).

---

## Appendix B. Decisions and follow-ups

Items for the lead and the owner. None blocks M1.

1. **"{N} left" above the urgent threshold.** SD §8.2 writes "Only N left" for every `avail > 0`, which invents urgency at large numbers ("Only 488 left"). This document adopts "{N} left" above the urgent threshold and "Only {N} left" at or below it (§9.9, §1.5). The lead should bring SD §8.2's wording in line, and E2E specs should match on the number, not on "Only".
2. **Finding an order again.** SD §8.1 has no `/orders` list. Instead of a new route, the signed-in `/login` page is the account page and lists the latest 10 orders from `GET /me/orders` (§10.6). That response needs, per order, the product title and its first image key, besides status, total and `createdAt` (M3 contract).
3. **Images from `/uploads`.** §11.4 recommends `remotePatterns` plus `dangerouslyAllowLocalIP` for our own `api`. The alternative is a custom `next/image` loader with widths generated at upload time by `sharp` and served by Caddy; it is more work and avoids the optimizer. M1 decides and records the choice here.
4. **Tracking check.** M1 checks both tracking columns on Windows (Inter) and on macOS and iOS (SF Pro) against apple.com, may move any value by up to ±0.02em, and records the result (§3.2).
5. **Always-dark live room.** The live room ignores the light preference on purpose (§10.3). The owner can overrule it; the tokens support both.
6. **Theme preference per device.** Stored in `localStorage`, not on the account, because accounts are dev logins.
7. **Inter file.** M1 copies `files/inter-latin-opsz-normal.woff2` from `@fontsource-variable/inter` 5.3.0 to `apps/web/app/fonts/InterVariable.woff2`, with the package's `LICENSE` as `OFL.txt`.
8. **Biome and Tailwind.** The root `biome.json` needs `"css": { "parser": { "tailwindDirectives": true } }` before `apps/web/styles/*.css` lands (§8.2); Biome 2.5.15 rejects `@theme` and `@utility` otherwise.
9. **Order fields for the status page.** §10.5 tells a decline from a closed payment window by the payment's decline code, so the order response needs `declineCode` (from `payments.decline_code`). An expiry after checkout is recognised from the shipping and payment method the response already carries.
10. **Hero crop.** The square home hero (§10.1) relies on seed photos keeping the product within 80% of the short side (§11.2). M1's seed check covers it.
