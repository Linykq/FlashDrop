/*
 * Text shaping for display: initials for avatars and short forms of product copy. Product descriptions are
 * written in full sentences (catalog.json, ListingDraft rules), so sentence boundaries are the natural places
 * to cut them.
 */

const LOCALE = 'en-US';
const graphemes = new Intl.Segmenter(LOCALE, { granularity: 'grapheme' });
const sentences = new Intl.Segmenter(LOCALE, { granularity: 'sentence' });

function firstGrapheme(word: string): string {
  return graphemes.segment(word)[Symbol.iterator]().next().value?.segment ?? '';
}

/** "Mira Chen" → "MC", "Chloé Martin" → "CM", "Mira" → "M": first and last word, as avatars show them. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (first === undefined) return '';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return `${firstGrapheme(first)}${last === undefined ? '' : firstGrapheme(last)}`.toLocaleUpperCase(LOCALE);
}

const ARTICLES = new Set(['a', 'an', 'the']);

/** Lower-cased words, keeping inner hyphens and apostrophes ("over-ear", "don't"). */
function words(text: string): string[] {
  return text.toLocaleLowerCase(LOCALE).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

/**
 * The home hero's intro line (§10.1): the description's first sentence, unless it opens by restating the
 * title shown right above it (title "Sage Wireless Over-Ear Headphones", sentence "Over-ear headphones in a
 * calm sage…"); then the first sentence that doesn't. A sentence restates the title when its first two words
 * after a leading article are both title words. `null` when every sentence does.
 */
export function introSentence(description: string, title: string): string | null {
  const titleWords = new Set(words(title));
  for (const { segment } of sentences.segment(description.trim())) {
    const all = words(segment);
    const start = all.findIndex((word) => !ARTICLES.has(word));
    const opening = start === -1 ? [] : all.slice(start, start + 2);
    if (opening.length > 0 && !opening.every((word) => titleWords.has(word))) return segment.trim();
  }
  return null;
}

/**
 * At most `max` characters for a meta description: whole sentences while they fit, otherwise the first
 * sentence cut at a word boundary with an ellipsis.
 */
export function summarize(text: string, max = 160): string {
  let summary = '';
  for (const { segment } of sentences.segment(text.trim())) {
    const next = `${summary}${segment}`.trim();
    if (next.length > max) break;
    summary = `${summary}${segment}`;
  }
  if (summary.trim()) return summary.trim();
  const cut = text.slice(0, max - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).replace(/[\s,;:.]+$/, '')}…`;
}
