import {
  LISTING_LIMITS,
  ListingDraft,
  type ListingIssue,
  type ListingJob,
  type ListingUncertainty,
  type ListingWire,
  type ProductCategory,
  type ProductCondition,
  REQUIRED_ATTRIBUTES,
} from '@flashdrop/contracts';
import { formatCount, plural } from '../../lib/format';

/*
 * The listing review form's model (SD §10, design system §10.9) as pure functions: its values, what the
 * admin changed against the model's draft (the AI badges and the edit rate), each uncertainty and issue on
 * its field, and the checks, which are `ListingDraft` itself, so the form can never accept a listing the
 * server would refuse, or refuse one it would accept.
 */

export const REVIEW_FIELDS = [
  'title',
  'description',
  'highlights',
  'category',
  'condition',
  'brand',
  'color',
  'material',
  'size',
  'tags',
] as const;
export type ReviewField = (typeof REVIEW_FIELDS)[number];

export const FIELD_LABELS: Readonly<Record<ReviewField, string>> = {
  title: 'Title',
  description: 'Description',
  highlights: 'Highlights',
  category: 'Category',
  condition: 'Condition',
  brand: 'Brand',
  color: 'Color',
  material: 'Material',
  size: 'Size',
  tags: 'Tags',
};

const ATTRIBUTES = ['brand', 'color', 'material', 'size'] as const;
type AttributeField = (typeof ATTRIBUTES)[number];

export type ReviewValues = {
  title: string;
  description: string;
  highlights: string[];
  /** Empty until chosen, when no draft had one. */
  category: ProductCategory | '';
  condition: ProductCondition | '';
  brand: string;
  color: string;
  material: string;
  size: string;
  tags: string[];
};

/** Where an error shows: a field, or one entry of the highlights list. */
export type ErrorKey = ReviewField | `highlights.${number}`;
export type ReviewErrors = Partial<Record<ErrorKey, string>>;

export const EMPTY_VALUES: ReviewValues = {
  title: '',
  description: '',
  highlights: ['', '', ''],
  category: '',
  condition: '',
  brand: '',
  color: '',
  material: '',
  size: '',
  tags: [],
};

/** The form's starting values: the model's draft, or empty when no call produced one. */
export function valuesFromDraft(draft: ListingWire | null): ReviewValues {
  if (draft === null) return EMPTY_VALUES;
  return {
    title: draft.title,
    description: draft.description,
    highlights: draft.highlights.length > 0 ? [...draft.highlights] : [''],
    category: draft.category,
    condition: draft.condition,
    brand: draft.attributes.brand ?? '',
    color: draft.attributes.color ?? '',
    material: draft.attributes.material ?? '',
    size: draft.attributes.size ?? '',
    tags: [...draft.tags],
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Whether the admin changed a field from the model's draft: its AI badge becomes "Edited" (§10.9). Compared
 * as typed, so changing a word and changing it back counts as unchanged.
 */
export function isEdited(field: ReviewField, values: ReviewValues, draft: ReviewValues): boolean {
  const value = values[field];
  const original = draft[field];
  if (Array.isArray(value) && Array.isArray(original)) return !sameList(value, original);
  return value !== original;
}

/** Whether a field holds nothing: a blank text, or a list of blank entries. */
export function isEmptyValue(value: string | readonly string[]): boolean {
  return typeof value === 'string' ? value.trim() === '' : value.every((entry) => entry.trim() === '');
}

/** The listing as the form describes it, before the repair `ListingDraft` applies. */
export function toWire(values: ReviewValues, uncertainties: readonly ListingUncertainty[]): ListingWire {
  const attribute = (field: AttributeField) => (values[field].trim() === '' ? null : values[field]);
  return {
    title: values.title,
    description: values.description,
    highlights: values.highlights,
    // An unset choice is checked below, before this value can be sent.
    category: values.category === '' ? 'apparel' : values.category,
    condition: values.condition === '' ? 'new' : values.condition,
    attributes: {
      brand: attribute('brand'),
      color: attribute('color'),
      material: attribute('material'),
      size: attribute('size'),
    },
    tags: values.tags,
    uncertainties: [...uncertainties],
  };
}

/** A path of api's or `ListingDraft`'s issues (`attributes.size`, `highlights.2`) as the form's error key. */
export function errorKeyOf(path: string): ErrorKey | null {
  const plain = path.replace(/^listing\./, '').replace(/^attributes\./, '');
  const highlight = /^highlights\.(\d+)$/.exec(plain);
  if (highlight) return `highlights.${Number(highlight[1])}`;
  const tag = /^tags\.\d+$/.test(plain);
  if (tag) return 'tags';
  return (REVIEW_FIELDS as readonly string[]).includes(plain) ? (plain as ReviewField) : null;
}

/**
 * What an error of `key` takes focus to: the control with that id, except a highlights list error, which has
 * no control of its own: the first entry, or "Add highlight" (`null`) when the list is empty.
 */
export function focusKeyOf(key: ErrorKey, highlights: number): ErrorKey | null {
  if (key !== 'highlights') return key;
  return highlights > 0 ? 'highlights.0' : null;
}

/** The field an error key belongs to. */
export function fieldOfKey(key: ErrorKey): ReviewField {
  return key.startsWith('highlights.') ? 'highlights' : (key as ReviewField);
}

/** "Title must be at most 80 characters (is 92)." from `title` and the rule's predicate. */
function sentence(key: ErrorKey, message: string): string {
  const field = fieldOfKey(key);
  const subject = key.startsWith('highlights.')
    ? `Highlight ${Number(key.split('.')[1]) + 1}`
    : FIELD_LABELS[field];
  const text = /^[a-z]/.test(message) ? `${subject} ${message}` : message;
  return text.endsWith('.') ? text : `${text}.`;
}

/** Issues the job came with (NEEDS_REVIEW), on the form's fields. */
export function issueErrors(issues: readonly ListingIssue[]): ReviewErrors {
  const errors: ReviewErrors = {};
  for (const issue of issues) {
    const key = errorKeyOf(issue.path);
    if (key !== null) errors[key] ??= sentence(key, issue.message);
  }
  return errors;
}

const asSentence = (text: string) => (/[.?!]$/.test(text) ? text : `${text}.`);

/** Issues the job came with that no field shows (an answer cut off at the output limit), for the banner. */
export function generalIssues(issues: readonly ListingIssue[]): string[] {
  const messages = issues
    .filter((issue) => errorKeyOf(issue.path) === null)
    .map((issue) => asSentence(issue.message.trim()));
  return [...new Set(messages)];
}

export type ReviewBanner = { title: string; body: string; startOver: boolean };

/**
 * What the NEEDS_REVIEW banner says (§10.9, §12.2). With no draft at all, the form is empty and nothing is
 * highlighted, so it says so, with the job's own reason and the way back; otherwise it points at the fields,
 * or, when no field has an issue, at the whole form. READY needs no banner.
 */
export function reviewBanner(job: Pick<ListingJob, 'status' | 'draft' | 'issues'>): ReviewBanner | null {
  if (job.status !== 'NEEDS_REVIEW') return null;
  const general = generalIssues(job.issues);
  if (job.draft === null) {
    return {
      title: 'Nothing was drafted.',
      body: [...general, 'Fill in every field to publish, or start over.'].join(' '),
      startOver: true,
    };
  }
  const highlighted = Object.keys(issueErrors(job.issues)).length > 0;
  return {
    title: 'Some fields need attention.',
    body: [
      ...general,
      highlighted ? 'Fix the highlighted fields to publish.' : 'Check every field before you publish.',
    ].join(' '),
    startOver: false,
  };
}

/** The action bar's state line (§10.9): unchanged fields and open uncertainties, or what an empty form needs. */
export function reviewStatus(hasDraft: boolean, unchanged: number, open: number): string {
  if (!hasDraft) return 'Fill in every field';
  return [
    `${formatCount(unchanged)} ${plural(unchanged, 'field', 'fields')} unchanged`,
    open > 0 ? `${formatCount(open)} ${plural(open, 'uncertainty', 'uncertainties')} open` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Every problem with the form's values, by field: unset choices and blank highlights first (a blank entry
 * would be dropped by the repair and shift the others' positions), then exactly what `ListingDraft` refuses.
 */
export function validateReview(values: ReviewValues): ReviewErrors {
  const errors: ReviewErrors = {};
  if (values.category === '') errors.category = 'Choose a category.';
  if (values.condition === '') errors.condition = 'Choose a condition.';
  values.highlights.forEach((highlight, index) => {
    if (highlight.trim() === '')
      errors[`highlights.${index}`] = `Enter highlight ${index + 1}, or remove it.`;
  });
  if (Object.keys(errors).length > 0) return errors;

  const result = ListingDraft.safeParse(toWire(values, []));
  if (result.success) return errors;
  for (const issue of result.error.issues) {
    const key = errorKeyOf(issue.path.join('.'));
    if (key !== null) errors[key] ??= sentence(key, issue.message);
  }
  return errors;
}

/** Attributes the chosen category can't be listed without (`REQUIRED_ATTRIBUTES`), for their helper text. */
export function requiredAttributes(category: ReviewValues['category']): readonly string[] {
  return category === '' ? [] : REQUIRED_ATTRIBUTES[category];
}

/** Characters as `ListingDraft` counts them (code points, after the repair's whitespace collapse). */
export function characterCount(text: string, multiline = false): number {
  const repaired = multiline ? text.replace(/[^\S\n]+/gu, ' ').trim() : text.replace(/\s+/gu, ' ').trim();
  return [...repaired.normalize('NFC')].length;
}

export { LISTING_LIMITS };
