import type { ListingWire } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import {
  characterCount,
  errorKeyOf,
  focusKeyOf,
  generalIssues,
  isEdited,
  isEmptyValue,
  issueErrors,
  requiredAttributes,
  reviewBanner,
  reviewStatus,
  toWire,
  validateReview,
  valuesFromDraft,
} from './listing-review-model';

const DRAFT: ListingWire = {
  title: 'Linen Band-Collar Shirt',
  description:
    'A relaxed band-collar shirt in washed linen, with a soft drape, a curved hem and mother-of-pearl buttons.',
  highlights: ['Washed linen', 'Band collar', 'Curved hem'],
  category: 'apparel',
  attributes: { brand: null, color: 'Oat', material: 'Linen', size: 'M' },
  condition: 'new',
  tags: ['linen', 'shirt'],
  uncertainties: [{ field: 'brand', note: 'No label is visible.' }],
};

describe('listing review model', () => {
  it('starts from the draft, and from empty fields without one', () => {
    const values = valuesFromDraft(DRAFT);
    expect(values).toMatchObject({ brand: '', color: 'Oat', size: 'M', category: 'apparel' });
    expect(valuesFromDraft(null)).toMatchObject({ title: '', category: '', highlights: ['', '', ''] });
  });

  it('marks a field edited only while it differs from the draft', () => {
    const draft = valuesFromDraft(DRAFT);
    expect(isEdited('title', { ...draft, title: 'Linen Shirt With Band Collar' }, draft)).toBe(true);
    expect(isEdited('title', { ...draft }, draft)).toBe(false);
    expect(isEdited('tags', { ...draft, tags: ['linen'] }, draft)).toBe(true);
    expect(isEdited('tags', { ...draft, tags: ['linen', 'shirt'] }, draft)).toBe(false);
  });

  it('accepts the draft as is, and sends blank attributes as null', () => {
    const values = valuesFromDraft(DRAFT);
    expect(validateReview(values)).toEqual({});
    expect(toWire(values, []).attributes).toEqual({
      brand: null,
      color: 'Oat',
      material: 'Linen',
      size: 'M',
    });
  });

  it('words ListingDraft rules on their fields', () => {
    const values = valuesFromDraft(DRAFT);
    expect(validateReview({ ...values, title: 'Short' })).toEqual({
      title: 'Title must be at least 10 characters (is 5).',
    });
    expect(validateReview({ ...values, size: '' })).toEqual({ size: 'Size is required for apparel.' });
    expect(
      validateReview({ ...values, highlights: ['Washed linen', 'Only $20 today', 'Curved hem'] }),
    ).toEqual({
      'highlights.1': 'Highlight 2 must not mention a price or currency.',
    });
    expect(validateReview({ ...values, highlights: ['Washed linen'] })).toEqual({
      highlights: 'Highlights must have 3 to 6 entries (has 1).',
    });
  });

  it('asks for unset choices and blank highlights before anything else', () => {
    const errors = validateReview({ ...valuesFromDraft(null), title: 'x' });
    expect(errors).toMatchObject({
      category: 'Choose a category.',
      condition: 'Choose a condition.',
      'highlights.0': 'Enter highlight 1, or remove it.',
    });
    expect(errors.title).toBeUndefined();
  });

  it('maps api and job issue paths onto the form', () => {
    expect(errorKeyOf('attributes.size')).toBe('size');
    expect(errorKeyOf('listing.highlights.2')).toBe('highlights.2');
    expect(errorKeyOf('tags.4')).toBe('tags');
    expect(errorKeyOf('uncertainties.0.note')).toBeNull();
    expect(issueErrors([{ path: 'title', message: 'must be at most 80 characters (is 92)' }])).toEqual({
      title: 'Title must be at most 80 characters (is 92).',
    });
  });

  it('counts characters the way the rules do', () => {
    expect(characterCount('  Linen   shirt ')).toBe(11);
    expect(characterCount('Café')).toBe(4);
    expect(requiredAttributes('home')).toEqual(['material']);
    expect(requiredAttributes('')).toEqual([]);
  });

  it('keeps the issues no field shows for the banner, which says why when nothing was drafted', () => {
    const cutOff = { path: '', message: 'The answer was cut off at the output limit.' };
    expect(issueErrors([cutOff])).toEqual({});
    expect(
      generalIssues([cutOff, { path: 'title', message: 'must be at most 80 characters' }, cutOff]),
    ).toEqual(['The answer was cut off at the output limit.']);
    expect(reviewBanner({ status: 'NEEDS_REVIEW', draft: null, issues: [cutOff] })).toEqual({
      title: 'Nothing was drafted.',
      body: 'The answer was cut off at the output limit. Fill in every field to publish, or start over.',
      startOver: true,
    });
  });

  it('points at the highlighted fields only when some field has an issue', () => {
    const titleIssue = { path: 'title', message: 'must be at most 80 characters (is 92)' };
    expect(reviewBanner({ status: 'NEEDS_REVIEW', draft: DRAFT, issues: [titleIssue] })).toEqual({
      title: 'Some fields need attention.',
      body: 'Fix the highlighted fields to publish.',
      startOver: false,
    });
    expect(
      reviewBanner({
        status: 'NEEDS_REVIEW',
        draft: DRAFT,
        issues: [{ path: 'listing', message: 'Odd output' }],
      })?.body,
    ).toBe('Odd output. Check every field before you publish.');
    expect(reviewBanner({ status: 'READY', draft: DRAFT, issues: [] })).toBeNull();
  });

  it('states the review in the action bar, leaving out uncertainties once none is open', () => {
    expect(reviewStatus(true, 7, 2)).toBe('7 fields unchanged · 2 uncertainties open');
    expect(reviewStatus(true, 1, 0)).toBe('1 field unchanged');
    expect(reviewStatus(false, 10, 0)).toBe('Fill in every field');
  });

  it('sends a highlights list error to the first entry, or to "Add highlight" when there is none', () => {
    expect(focusKeyOf('highlights', 2)).toBe('highlights.0');
    expect(focusKeyOf('highlights', 0)).toBeNull();
    expect(focusKeyOf('highlights.1', 2)).toBe('highlights.1');
    expect(focusKeyOf('title', 2)).toBe('title');
  });

  it('knows an empty field, text or list', () => {
    expect(isEmptyValue('  ')).toBe(true);
    expect(isEmptyValue('M')).toBe(false);
    expect(isEmptyValue(['', ' '])).toBe(true);
    expect(isEmptyValue(['linen'])).toBe(false);
  });
});
