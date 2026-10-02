import { z } from 'zod';

/*
 * Formats the database enforces too: `packages/db` builds its CHECK constraints from these sources, so a row
 * that a response schema would refuse cannot be stored (one bad slug would otherwise turn `GET /drops` into
 * a 500 for every visitor). Unanchored, and valid both as JavaScript regexes and as PostgreSQL AREs.
 */
export const SLUG_PATTERN = '[a-z0-9]+(?:-[a-z0-9]+)*';
export const SLUG_MAX_LENGTH = 96;
export const CURRENCY_PATTERN = '[A-Z]{3}';
export const IMAGE_KEY_PATTERN = '[0-9a-f]{64}\\.jpg';

const whole = (pattern: string) => new RegExp(`^${pattern}$`);

/** Every id in FlashDrop is a uuid: v4 or v5 for seeded rows, v5 for reservation ids, v7 for event ids. */
export const Uuid = z.uuid();

/** URL-safe lowercase slug, as used in `/p/[slug]` and `/live/[slug]`. */
export const Slug = z
  .string()
  .max(SLUG_MAX_LENGTH)
  .regex(whole(SLUG_PATTERN), 'must be lowercase words joined by hyphens');

/**
 * An absolute https URL on a public host. Plain `z.url()` also accepts `javascript:` and `data:` URLs, and
 * these end up in `<a href>`.
 */
export const HttpsUrl = z.url({ protocol: /^https$/, hostname: z.regexes.domain });

/**
 * An instant on the wire: ISO 8601 in UTC, exactly what `Date.prototype.toISOString` produces. Timestamps
 * stay strings in DTOs, so the same schema validates what `api` sends and what `web` receives.
 */
export const IsoDateTime = z.iso.datetime();

/** ISO 4217 currency code. Prices are typed by an admin, never by the LLM (§3). */
export const Currency = z.string().regex(whole(CURRENCY_PATTERN), 'must be an ISO 4217 code such as USD');

/** Money in minor units. Integer cents avoid float rounding anywhere a price is added up. */
export const Cents = z.int().positive();

/**
 * A stored product photo: the file name `<sha256>.jpg` under `UPLOAD_DIR`, served by `api` at
 * `/uploads/<key>` (§10, design system §11.4). Content-addressed, so a key never changes meaning.
 */
export const ImageKey = z.string().regex(whole(IMAGE_KEY_PATTERN), 'must be <sha256>.jpg');
export type ImageKey = z.infer<typeof ImageKey>;

/** The path `api` serves a stored photo at; `web` prefixes the API origin for `next/image`. */
export function uploadPath(key: ImageKey): `/uploads/${string}` {
  return `/uploads/${key}`;
}
