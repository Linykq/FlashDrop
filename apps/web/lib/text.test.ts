import { describe, expect, it } from 'vitest';
import { initials, introSentence, summarize } from './text';

describe('initials', () => {
  it.each([
    ['Mira Chen', 'MC'],
    ['Chloé Martin', 'CM'],
    ['  ada   lindqvist ', 'AL'],
    ['Mira', 'M'],
    ['Mary Ann Smith', 'MS'],
    ['Émile Zola', 'ÉZ'],
    ['', ''],
  ])('%j → %j', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

const description =
  'A pared-back routine in soft-touch white: a gentle gel cleanser and a rich day cream. Everything you need for morning and night, and nothing you don’t.';

describe('introSentence', () => {
  it('is the first sentence', () => {
    expect(introSentence(description, 'Daily Ritual Skincare Set')).toBe(
      'A pared-back routine in soft-touch white: a gentle gel cleanser and a rich day cream.',
    );
    expect(introSentence('  Matte stoneware.  ', 'Ring Stoneware Vase')).toBe('Matte stoneware.');
  });

  it('skips a sentence that opens by restating the title', () => {
    const headphones =
      'Over-ear headphones in a calm sage and warm ivory colorway. Plush cushions rest lightly for hours.';
    expect(introSentence(headphones, 'Sage Wireless Over-Ear Headphones')).toBe(
      'Plush cushions rest lightly for hours.',
    );
    expect(introSentence('The Ring Vase, by hand.', 'Ring Stoneware Vase')).toBeNull();
  });

  it('keeps a sentence that only shares one opening word with the title', () => {
    expect(introSentence('Sage tones throughout.', 'Sage Wireless Headphones')).toBe(
      'Sage tones throughout.',
    );
  });
});

describe('summarize', () => {
  it('keeps whole sentences while they fit', () => {
    expect(summarize(description, 400)).toBe(description);
    expect(summarize(description, 100)).toBe(
      'A pared-back routine in soft-touch white: a gentle gel cleanser and a rich day cream.',
    );
  });

  it('cuts a long first sentence at a word boundary', () => {
    expect(summarize(description, 40)).toBe('A pared-back routine in soft-touch…');
  });
});
