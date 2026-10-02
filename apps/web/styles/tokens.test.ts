import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Token parity and contrast (design-system §8.8, Appendix A). Parses tokens.css itself, so changing a colour
 * without keeping its contrast, or adding a token without a dark value, fails CI.
 */

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

function block(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start < 0) throw new Error(`no ${opener} block in tokens.css`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unclosed ${opener} block`);
}

function declarations(source: string, prefix: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of source.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    if (name?.startsWith(prefix) && value) found.set(name.slice(prefix.length), value.trim());
  }
  return found;
}

const theme = block(css, '@theme');
const dark = block(css, '@variant dark');
const light = { colors: declarations(theme, 'color-'), elevations: declarations(theme, 'elevation-') };
const darkTokens = { colors: declarations(dark, 'color-'), elevations: declarations(dark, 'elevation-') };

/** Colours that are deliberately identical in both modes (§2). */
const SAME_IN_BOTH = [
  'accent',
  'accent-hover',
  'accent-pressed',
  'live',
  'label-on-color',
  'material-overlay',
  'material-overlay-solid',
];

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
  if (hex)
    return {
      r: Number.parseInt(hex[1] ?? '', 16),
      g: Number.parseInt(hex[2] ?? '', 16),
      b: Number.parseInt(hex[3] ?? '', 16),
      a: 1,
    };
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (rgb)
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  throw new Error(`unsupported colour ${value}`);
}

/** Source-over compositing in sRGB, as browsers paint. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function withAlpha(color: Rgba, alpha: number): Rgba {
  return { ...color, a: color.a * alpha };
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast of a (possibly translucent) foreground over an opaque background. */
function contrast(foreground: Rgba, background: Rgba): number {
  const [a, b] = [luminance(over(foreground, background)), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const BLACK = parseColor('#000000');
const WHITE = parseColor('#ffffff');

type Mode = 'light' | 'dark';

function color(mode: Mode, name: string): Rgba {
  const value = (mode === 'dark' ? darkTokens.colors.get(name) : undefined) ?? light.colors.get(name);
  if (value === undefined) throw new Error(`no --color-${name}`);
  return parseColor(value);
}

/** The worst contrast of `foreground` over each background, each background already composited. */
function worst(foreground: Rgba, backgrounds: Rgba[]): number {
  return Math.min(...backgrounds.map((background) => contrast(foreground, background)));
}

function surfaces(mode: Mode): Rgba[] {
  return ['bg', 'bg-secondary', 'surface', 'surface-raised'].map((name) => color(mode, name));
}

/** A translucent fill composited over `bg`, `bg-secondary` and `surface`: where tints and pills sit. */
function tinted(mode: Mode, tint: string): Rgba[] {
  return ['bg', 'bg-secondary', 'surface'].map((name) => over(color(mode, tint), color(mode, name)));
}

/** A material over the content that is worst for it: black under a light material, white under a dark one. */
function material(mode: Mode, name: 'material-bar' | 'material-thick'): Rgba {
  return over(color(mode, name), mode === 'light' ? BLACK : WHITE);
}

describe('token parity', () => {
  it('declares every dark colour and elevation in @theme', () => {
    for (const name of darkTokens.colors.keys()) expect(light.colors.has(name), `--color-${name}`).toBe(true);
    for (const name of darkTokens.elevations.keys()) {
      expect(light.elevations.has(name), `--elevation-${name}`).toBe(true);
    }
  });

  it('gives every colour a dark value, except those that are the same in both modes', () => {
    const lightOnly = [...light.colors.keys()].filter((name) => !darkTokens.colors.has(name));
    expect(lightOnly.sort()).toEqual([...SAME_IN_BOTH].sort());
    expect([...darkTokens.elevations.keys()].sort()).toEqual([...light.elevations.keys()].sort());
  });
});

describe.each<Mode>(['light', 'dark'])('contrast in %s mode (Appendix A)', (mode) => {
  const c = (name: string) => color(mode, name);

  it.each([
    ['label', 4.5],
    ['label-secondary', 4.5],
    ['label-tertiary', 3],
    ['control', 3],
    ['accent-label', 4.5],
    ['success', 4.5],
    ['warning', 4.5],
    ['danger', 4.5],
    ['focus', 3],
  ] as const)('%s on surfaces is at least %d:1', (name, minimum) => {
    expect(worst(c(name), surfaces(mode))).toBeGreaterThanOrEqual(minimum);
  });

  it.each([
    ['accent-label', 'accent-tint'],
    ['accent-label', 'accent-tint-hover'],
    ['success', 'success-tint'],
    ['warning', 'warning-tint'],
    ['danger', 'danger-tint'],
    ['danger', 'danger-tint-hover'],
    ['label', 'fill-tertiary'],
  ] as const)('%s on %s keeps 4.5:1', (name, tint) => {
    expect(worst(c(name), tinted(mode, tint))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['accent', 'accent-hover', 'accent-pressed', 'live'])(
    'label-on-color on %s keeps 4.5:1',
    (fill) => {
      expect(contrast(c('label-on-color'), c(fill))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('keeps label readable on the segmented thumb', () => {
    expect(contrast(c('label'), c('thumb'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps label, the 80% navigation links and gray buttons readable on materials over the worst content', () => {
    for (const name of ['material-bar', 'material-thick'] as const) {
      const base = material(mode, name);
      expect(contrast(c('label'), base), name).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(c('label'), over(c('fill-tertiary'), base)),
        `gray button on ${name}`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c('focus'), base), `focus on ${name}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(withAlpha(c('label'), 0.8), material(mode, 'material-bar'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps toast status icons at 3:1 on material-thick over the worst content', () => {
    for (const name of ['success', 'warning', 'danger', 'accent-label']) {
      expect(contrast(c(name), material(mode, 'material-thick')), name).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('material-overlay over a white video frame', () => {
  // Always dark, the same in both modes; its subtree's `label` is white.
  const overlay = over(parseColor(light.colors.get('material-overlay') ?? ''), WHITE);

  it('keeps white and white at 80% readable', () => {
    expect(contrast(WHITE, overlay)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(withAlpha(WHITE, 0.8), overlay)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps white text on the hover wash and white icons on the pressed wash', () => {
    expect(contrast(WHITE, over(withAlpha(WHITE, 0.16), overlay))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, over(withAlpha(WHITE, 0.24), overlay))).toBeGreaterThanOrEqual(3);
  });
});
