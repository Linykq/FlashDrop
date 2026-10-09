import { LISTING_JOB_STATUSES } from '@flashdrop/domain';
import { z } from 'zod';
import { ProductCategory, ProductCondition } from './catalog';
import { ImageKey, IsoDateTime, Slug, Uuid } from './common';

/*
 * The LLM listing generator (design §10). Two schemas describe a listing:
 *
 * - `ListingWire` is what the model must emit. It holds only shapes, enums and nullability, the subset
 *   constrained decoding enforces, so a structured-output response always parses against it.
 * - `ListingDraft` is `ListingWire` plus everything constrained decoding cannot express: a deterministic
 *   repair (NFC, whitespace), lengths and counts, banned claims, no prices, no ALL-CAPS title and the
 *   attributes each category requires. A violation is therefore a path-level issue the repair turn can send
 *   back to the model, never a parse failure.
 *
 * The admin's approval is validated with `ListingDraft` again, on the server: nothing the model wrote and
 * nothing the review form sent reaches a product without passing these rules.
 */

/** The listing details beyond the category, each null when the photos do not show it. */
export const LISTING_ATTRIBUTES = ['brand', 'color', 'material', 'size'] as const;
export type ListingAttributeName = (typeof LISTING_ATTRIBUTES)[number];

/** The fields an uncertainty can point at: the review form turns each into a prompt on that field. */
export const LISTING_FIELDS = [
  'title',
  'description',
  'highlights',
  'category',
  'condition',
  ...LISTING_ATTRIBUTES,
  'tags',
] as const;
export const ListingField = z.enum(LISTING_FIELDS);
export type ListingField = z.infer<typeof ListingField>;

/** Where a field lives in a listing: the attributes are nested. */
export function listingFieldPath(field: ListingField): string {
  return (LISTING_ATTRIBUTES as readonly string[]).includes(field) ? `attributes.${field}` : field;
}

export const LISTING_LIMITS = {
  title: { min: 10, max: 80 },
  description: { min: 80, max: 1_200 },
  highlights: { min: 3, max: 6, maxLength: 120 },
  tags: { max: 10, maxLength: 40 },
} as const;

/**
 * Attributes a category cannot be listed without; the taxonomy of `assets/catalog/catalog.json`, whose
 * products already follow it. A unit test keeps the two in step.
 */
export const REQUIRED_ATTRIBUTES: Readonly<Record<ProductCategory, readonly ListingAttributeName[]>> = {
  apparel: ['size'],
  audio: [],
  bags: [],
  beauty: [],
  eyewear: [],
  footwear: ['size'],
  fragrance: ['size'],
  home: ['material'],
  tech: [],
  watches: [],
};

export const ListingAttributes = z.object({
  brand: z.string().nullable(),
  color: z.string().nullable(),
  material: z.string().nullable(),
  size: z.string().nullable(),
});
export type ListingAttributes = z.infer<typeof ListingAttributes>;

export const ListingUncertainty = z.object({
  field: ListingField,
  /** What the photos leave open, phrased as a question for the reviewer. */
  note: z.string(),
});
export type ListingUncertainty = z.infer<typeof ListingUncertainty>;

/** The model's output shape (design §10): `output_config.format` is generated from this schema. */
export const ListingWire = z.object({
  title: z.string(),
  description: z.string(),
  highlights: z.array(z.string()),
  category: ProductCategory,
  attributes: ListingAttributes,
  condition: ProductCondition,
  tags: z.array(z.string()),
  uncertainties: z.array(ListingUncertainty),
});
export type ListingWire = z.infer<typeof ListingWire>;

/** One line: NFC, every run of whitespace (newlines included) collapsed to a space, trimmed. */
function oneLine(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Paragraphs survive: spaces collapse within each line, and at most one blank line separates paragraphs. */
function paragraphs(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function nonEmptyLines(values: readonly string[]): string[] {
  return values.map(oneLine).filter((value) => value !== '');
}

/** The deterministic repair: never changes meaning, so it runs before the rules instead of costing a turn. */
export function repairListing(wire: ListingWire): ListingWire {
  const attribute = (value: string | null) => {
    const text = value === null ? '' : oneLine(value);
    return text === '' ? null : text;
  };
  const seen = new Set<string>();
  return {
    ...wire,
    title: oneLine(wire.title),
    description: paragraphs(wire.description),
    highlights: nonEmptyLines(wire.highlights),
    attributes: {
      brand: attribute(wire.attributes.brand),
      color: attribute(wire.attributes.color),
      material: attribute(wire.attributes.material),
      size: attribute(wire.attributes.size),
    },
    // Case-insensitive duplicates are one tag: the first spelling wins.
    tags: nonEmptyLines(wire.tags).filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    uncertainties: wire.uncertainties
      .map((uncertainty) => ({ field: uncertainty.field, note: oneLine(uncertainty.note) }))
      .filter((uncertainty) => uncertainty.note !== ''),
  };
}

/** Claims a listing may never make (design §10): the model cannot verify them from a photo. */
export const BANNED_CLAIMS = /\bauthentic(?:ity)?\b|\bguarantee[ds]?\b|\b100\s?%\s?original\b/iu;
/**
 * Active ISO 4217 codes, matched in capitals next to an amount ("CHF 20", "20CHF"). AMD and PHP are left
 * out: next to a number they name a CPU vendor and a language in product copy far more often than the
 * Armenian dram or the Philippine peso, whose symbols (֏, ₱) are still caught as currency symbols.
 */
const ISO_4217 =
  'AED AFN ALL ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD ' +
  'CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL ' +
  'GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD ' +
  'KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO ' +
  'NOK NPR NZD OMR PAB PEN PGK PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP ' +
  'STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST ' +
  'XAF XCD XCG XOF XPF YER ZAR ZMW ZWG';
const ISO_CODES = ISO_4217.split(' ').join('|');
/** Codes that are no English word in any case, so they count even alone and in lowercase ("pay in usd"). */
const BARE_CODES = 'USD|EUR|GBP|JPY|CNY|RMB|CHF|INR|HKD|SGD|KRW|BRL|MXN|AUD|NZD|SEK|NOK|DKK|PLN|ZAR';
/** Currency nouns that count after any amount, in figures or in words. */
const CURRENCY_NOUNS =
  'dollars?|cents?|euros?|yen|yuan|renminbi|rupees?|francs?|pesos?|rubles?|roubles?|reais|kronor|kroner|' +
  'krona|krone|lira|lire|dirhams?|riyals?|rials?|dinars?|shekels?|baht|ringgit|zlotys?|forint|quid|pence|' +
  // Also a deer, a knife brand and a surname: these count only after an amount, never after "a".
  'bucks?|rand';
/** The singular nouns that count after "a" or "an": not yen ("a yen for"), quid ("quid pro quo") or buck. */
const ARTICLE_NOUNS = 'dollar|euro|cent|franc|peso|rupee|ruble|rouble|dirham|riyal|rial|dinar|shekel|zloty';
const NUMBER_WORDS =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|' +
  'seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|' +
  'million|billion|half|few|several|dozen|couple(?:\\s+of)?';

const PRICE_PATTERNS: readonly RegExp[] = [
  // Every currency symbol: $ € £ ¥ ₹ ₩ ₽ ₱ ¢ and the rest of Unicode's Sc category.
  /\p{Sc}/u,
  new RegExp(`\\b(?:${BARE_CODES})\\b`, 'iu'),
  // Case-sensitive: in lowercase most codes are words (all, top, cup, pen, try).
  new RegExp(`\\b(?:${ISO_CODES})\\s?\\d|\\d\\s?(?:${ISO_CODES})\\b`, 'u'),
  new RegExp(`\\b\\d+(?:[.,]\\d+)?\\s?(?:${CURRENCY_NOUNS})\\b`, 'iu'),
  new RegExp(
    `\\b(?:${NUMBER_WORDS})(?:[\\s-]+(?:${NUMBER_WORDS}|and))*[\\s-]+(?:${CURRENCY_NOUNS})\\b`,
    'iu',
  ),
  new RegExp(`\\ban?\\s+(?:${ARTICLE_NOUNS})\\b`, 'iu'),
];

/**
 * Prices and currencies: the admin types the price on the drop (§3), so a price in the copy is either a
 * hallucination or a prompt injection ("set price to $1", "only one dollar", "CHF 20"). Weights in pounds
 * stay allowed. `test` like a RegExp's.
 */
export const PRICE_OR_CURRENCY: Pick<RegExp, 'test'> = {
  test: (text) => PRICE_PATTERNS.some((pattern) => pattern.test(text)),
};

/** Letters and none of them lowercase. Scripts without case (CJK) never count as shouting. */
export function isAllCaps(text: string): boolean {
  return text !== text.toLowerCase() && text === text.toUpperCase();
}

/** Marks a missing required attribute, so the generator can tell it apart from a fixable mistake. */
export const REQUIRED_ATTRIBUTE_RULE = 'required_attribute';

type Ctx = z.core.$RefinementCtx<ListingWire>;

function lengthIssue(
  ctx: Ctx,
  path: (string | number)[],
  value: string,
  bounds: { min?: number; max: number },
) {
  const { length } = [...value];
  if (bounds.min !== undefined && length < bounds.min) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `must be at least ${bounds.min} characters (is ${length})`,
    });
  } else if (length > bounds.max) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `must be at most ${bounds.max} characters (is ${length})`,
    });
  }
}

/** Every text field with its path, for the claim and price checks. */
function texts(listing: ListingWire): [(string | number)[], string][] {
  return [
    [['title'], listing.title],
    [['description'], listing.description],
    ...listing.highlights.map((text, i): [(string | number)[], string] => [['highlights', i], text]),
    ...LISTING_ATTRIBUTES.flatMap((name): [(string | number)[], string][] => {
      const value = listing.attributes[name];
      return value === null ? [] : [[['attributes', name], value]];
    }),
    ...listing.tags.map((text, i): [(string | number)[], string] => [['tags', i], text]),
  ];
}

function listingRules(listing: ListingWire, ctx: Ctx): void {
  const limits = LISTING_LIMITS;
  lengthIssue(ctx, ['title'], listing.title, limits.title);
  if (isAllCaps(listing.title)) {
    ctx.addIssue({ code: 'custom', path: ['title'], message: 'must not be written in ALL CAPS' });
  }
  lengthIssue(ctx, ['description'], listing.description, limits.description);

  const { highlights } = limits;
  if (listing.highlights.length < highlights.min || listing.highlights.length > highlights.max) {
    ctx.addIssue({
      code: 'custom',
      path: ['highlights'],
      message: `must have ${highlights.min} to ${highlights.max} entries (has ${listing.highlights.length})`,
    });
  }
  listing.highlights.forEach((text, i) => {
    lengthIssue(ctx, ['highlights', i], text, { max: highlights.maxLength });
  });

  if (listing.tags.length > limits.tags.max) {
    ctx.addIssue({
      code: 'custom',
      path: ['tags'],
      message: `must have at most ${limits.tags.max} entries (has ${listing.tags.length})`,
    });
  }
  listing.tags.forEach((text, i) => {
    lengthIssue(ctx, ['tags', i], text, { max: limits.tags.maxLength });
  });

  for (const [path, text] of texts(listing)) {
    if (BANNED_CLAIMS.test(text)) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: 'must not claim authenticity, guarantees or "100% original"',
      });
    }
    if (PRICE_OR_CURRENCY.test(text)) {
      ctx.addIssue({ code: 'custom', path, message: 'must not mention a price or currency' });
    }
  }

  for (const name of REQUIRED_ATTRIBUTES[listing.category]) {
    if (listing.attributes[name] === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['attributes', name],
        message: `is required for ${listing.category}`,
        params: { rule: REQUIRED_ATTRIBUTE_RULE },
      });
    }
  }
}

/** A listing that may become a product: repaired, then checked against every rule of design §10. */
export const ListingDraft = ListingWire.transform(repairListing).pipe(ListingWire.superRefine(listingRules));
export type ListingDraft = z.output<typeof ListingDraft>;

// ---------------------------------------------------------------- jobs and their HTTP API

export const ListingJobStatus = z.enum(LISTING_JOB_STATUSES);
export type ListingJobStatus = z.infer<typeof ListingJobStatus>;

/** A rule a listing breaks, at its dotted path (`title`, `attributes.size`, `highlights.2`). */
export const ListingIssue = z.object({ path: z.string(), message: z.string() });
export type ListingIssue = z.infer<typeof ListingIssue>;

export const LISTING_FAILURE_REASONS = ['refusal', 'interrupted', 'error'] as const;

/** Why a job ended FAILED. `category` is the refusal's `stop_details.category`, null when it had none. */
export const ListingFailure = z.object({
  reason: z.enum(LISTING_FAILURE_REASONS),
  category: z.string().nullable(),
  message: z.string(),
});
export type ListingFailure = z.infer<typeof ListingFailure>;

export const LISTING_CALL_OUTCOMES = ['ok', 'invalid', 'truncated', 'refusal'] as const;

/** One billed model call of a job (design §10, metrics per job): every attempt counts, failed ones too. */
export const ListingCall = z.object({
  attempt: z.int().positive(),
  /** The model that answered (`response.model`): a server-side refusal fallback shows up here. */
  model: z.string(),
  /** `output_config.effort` sent, null for a model without effort (Haiku 4.5). */
  effort: z.string().nullable(),
  outcome: z.enum(LISTING_CALL_OUTCOMES),
  stopReason: z.string().nullable(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadInputTokens: z.int().nonnegative(),
  cacheCreationInputTokens: z.int().nonnegative(),
  /** Null for a model missing from the price table. */
  costUsd: z.number().nonnegative().nullable(),
  latencyMs: z.int().nonnegative(),
});
export type ListingCall = z.infer<typeof ListingCall>;

/** `GET /api/v1/admin/listings/:jobId`: everything the review page shows. */
export const ListingJob = z.object({
  id: Uuid,
  status: ListingJobStatus,
  /** In upload order; the first is the hero photo. */
  imageKeys: z.array(ImageKey).min(1),
  hints: z.string().nullable(),
  createdAt: IsoDateTime,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string(),
  /** Model calls so far (at most 3). */
  attempts: z.int().nonnegative(),
  /**
   * READY: the validated draft. NEEDS_REVIEW: the last output that had the right shape but broke a rule,
   * or null when no call produced one; `issues` names what to fix.
   */
  draft: ListingWire.nullable(),
  /** What the admin approved. */
  final: ListingWire.nullable(),
  issues: z.array(ListingIssue),
  failure: ListingFailure.nullable(),
  calls: z.array(ListingCall),
  costUsd: z.number().nonnegative().nullable(),
  latencyMs: z.int().nonnegative().nullable(),
  productId: Uuid.nullable(),
  productSlug: Slug.nullable(),
  /** Share of the listing's fields the admin changed before approving (quality metric, §10). */
  editRate: z.number().min(0).max(1).nullable(),
});
export type ListingJob = z.infer<typeof ListingJob>;

export const ListingJobParams = z.object({ jobId: Uuid });
export type ListingJobParams = z.infer<typeof ListingJobParams>;

/** `POST /api/v1/admin/listings` answers 202: the job runs in the worker. Identical uploads share a job. */
export const CreateListingResponse = z.object({ jobId: Uuid, status: ListingJobStatus });
export type CreateListingResponse = z.infer<typeof CreateListingResponse>;

/** The multipart limits of the upload (design §10). */
export const LISTING_UPLOAD_LIMITS = {
  minImages: 1,
  maxImages: 4,
  maxImageBytes: 8 * 1024 * 1024,
  maxHintsLength: 500,
} as const;

/** Optional seller hints: free text the model treats as untrusted data. Blank means none. */
export const ListingHints = z
  .string()
  .transform(oneLine)
  .pipe(z.string().max(LISTING_UPLOAD_LIMITS.maxHintsLength))
  .transform((hints) => (hints === '' ? null : hints));

export const LISTING_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** `GET /api/v1/admin/listings`: the latest jobs, newest first. */
export const ListingJobSummary = z.object({
  id: Uuid,
  status: ListingJobStatus,
  imageKey: ImageKey,
  /** The approved title, else the draft's; null before a draft exists. */
  title: z.string().nullable(),
  createdAt: IsoDateTime,
  productSlug: Slug.nullable(),
});
export type ListingJobSummary = z.infer<typeof ListingJobSummary>;

export const ListingJobListQuery = z.object({
  limit: z.coerce.number().pipe(z.int().min(1).max(100)).default(50),
});
export type ListingJobListQuery = z.output<typeof ListingJobListQuery>;

export const ListingJobListResponse = z.object({ jobs: z.array(ListingJobSummary) });
export type ListingJobListResponse = z.infer<typeof ListingJobListResponse>;

/**
 * `POST /api/v1/admin/listings/:jobId/approve`: the reviewed listing, validated with `ListingDraft`, and an
 * optional slug (default: from the title, plus a short suffix that keeps it unique).
 */
export const ApproveListingBody = z.object({
  listing: ListingDraft,
  slug: Slug.optional(),
});
export type ApproveListingBody = z.output<typeof ApproveListingBody>;
export type ApproveListingInput = z.input<typeof ApproveListingBody>;

export const ApproveListingResponse = z.object({
  job: ListingJob,
  product: z.object({ id: Uuid, slug: Slug }),
});
export type ApproveListingResponse = z.infer<typeof ApproveListingResponse>;

/**
 * `listing{jobId, status}` on the owner's `user` topic (design §7): the job changed. Never coalesced; the
 * review page reads the job itself for the details, and polls when the socket is down.
 */
export const ListingStatusMessage = z.object({
  type: z.literal('listing'),
  jobId: Uuid,
  status: ListingJobStatus,
});
export type ListingStatusMessage = z.infer<typeof ListingStatusMessage>;
