import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCues, recentCues, segmentSlugs } from './captions';

const SAMPLE = readFileSync(new URL('../public/hls/captions.en.vtt', import.meta.url), 'utf8');

describe('parseCues', () => {
  it("reads the sample stream's running order: one product per cue, in order", () => {
    const cues = parseCues(SAMPLE);
    expect(segmentSlugs(cues)).toEqual([
      'skincare-ritual-set',
      'sage-wireless-headphones',
      'linen-band-collar-shirt',
      'ring-stoneware-vase',
      'faceted-eau-de-parfum',
      'rose-tint-round-sunglasses',
      'amber-jar-candle',
      'stone-charcoal-mug-set',
    ]);
    expect(cues[1]).toEqual({
      id: 'sage-wireless-headphones',
      start: 5.7,
      end: 11.3,
      lines: ['Sage wireless headphones: plush cushions', 'and calm matte cups. So comfortable.'],
    });
  });

  it('skips the header, notes and cues without an id, with any line endings', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE a comment',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'No id',
      '',
      'a-slug',
      '00:01:02.500 --> 00:01:04.000 line:80%',
      'Spoken',
      '',
    ].join('\r\n');
    expect(parseCues(vtt)).toEqual([{ id: 'a-slug', start: 62.5, end: 64, lines: ['Spoken'] }]);
  });
});

describe('recentCues', () => {
  const cues = parseCues(SAMPLE);

  it('gives the cues spoken just before a moment, oldest first', () => {
    expect(recentCues(cues, 24, 3).map((cue) => cue.id)).toEqual([
      'linen-band-collar-shirt',
      'ring-stoneware-vase',
      'faceted-eau-de-parfum',
    ]);
  });

  it('wraps around the start of the loop', () => {
    expect(recentCues(cues, 6, 3).map((cue) => cue.id)).toEqual([
      'stone-charcoal-mug-set',
      'skincare-ritual-set',
      'sage-wireless-headphones',
    ]);
    expect(recentCues(cues, 0, 2).map((cue) => cue.id)).toEqual([
      'stone-charcoal-mug-set',
      'skincare-ritual-set',
    ]);
  });

  it('is empty without cues', () => {
    expect(recentCues([], 10, 3)).toEqual([]);
  });
});
