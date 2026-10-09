import { LISTING_IMAGE_TYPES, LISTING_UPLOAD_LIMITS } from '@flashdrop/contracts';

/*
 * The listing upload's checks and api's answers, as pure functions (design system §10.9). The browser checks
 * type, size and count before sending, mirroring the server, which stays authoritative: it reads magic bytes,
 * where the browser only sees the declared type and the name.
 */

const EXTENSIONS = /\.(jpe?g|png|webp)$/i;
const MEGABYTES = LISTING_UPLOAD_LIMITS.maxImageBytes / (1024 * 1024);

export type FileLike = { name: string; type: string; size: number; lastModified: number };

/** Why a chosen file can't be uploaded, in the words of §12.2; `null` when it can. */
export function fileProblem(file: FileLike): string | null {
  if (!(LISTING_IMAGE_TYPES as readonly string[]).includes(file.type) || !EXTENSIONS.test(file.name)) {
    return `${file.name} isn't a JPEG, PNG or WebP.`;
  }
  if (file.size > LISTING_UPLOAD_LIMITS.maxImageBytes) return `${file.name} is larger than ${MEGABYTES} MB.`;
  return null;
}

const sameFile = (a: FileLike, b: FileLike) =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/**
 * Adds newly chosen files to the chosen ones: each problem file is refused with its own message, repeats are
 * skipped quietly, and past the fourth photo the rest are refused by name.
 */
export function addFiles<F extends FileLike>(
  chosen: readonly F[],
  added: readonly F[],
): { files: F[]; problems: string[] } {
  const files = [...chosen];
  const problems: string[] = [];
  for (const file of added) {
    if (files.some((existing) => sameFile(existing, file))) continue;
    const problem = fileProblem(file);
    if (problem !== null) {
      problems.push(problem);
    } else if (files.length >= LISTING_UPLOAD_LIMITS.maxImages) {
      problems.push(`Choose up to ${LISTING_UPLOAD_LIMITS.maxImages} photos. ${file.name} wasn't added.`);
    } else {
      files.push(file);
    }
  }
  return { files, problems };
}

/**
 * What a choice of photos announces (§13.3), as one message: what was added and how many are chosen, then
 * every refusal, so a screen reader hears that `photo.heic` was refused, not silence. `null`: nothing to say.
 */
export function choiceAnnouncement(
  added: number,
  chosen: number,
  problems: readonly string[],
): string | null {
  const parts = [
    added > 0
      ? `${added} ${added === 1 ? 'photo' : 'photos'} added. ${chosen} of ${LISTING_UPLOAD_LIMITS.maxImages} chosen.`
      : null,
    ...problems,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** The long edge §11.2 asks of originals: enough for the 690 px product gallery at 2x after the 1568 px cap. */
export const SHARP_LONG_EDGE = 1600;

/**
 * A photo too small for a sharp product page (§11.2), from its decoded size: a warning, not a refusal, since
 * the generator reads it fine and it may be the only photo there is. `null` when it is large enough.
 */
export function resolutionNote(name: string, width: number, height: number): string | null {
  const long = Math.max(width, height);
  if (long >= SHARP_LONG_EDGE) return null;
  return `${name} is ${long} px ${width >= height ? 'wide' : 'tall'}. Product pages look best from ${SHARP_LONG_EDGE} px.`;
}

type Problem = { code?: unknown; errors?: unknown } | null;

/**
 * What api's refusal of an upload means for the admin. Field paths name the photo (`images.2`), which is
 * the third file sent; a refusal that names none reads "A photo".
 */
export function uploadFailure(status: number, body: Problem, names: readonly string[]): string {
  if (status === 429) return "You've started 10 listings in the last minute. Try again in a moment.";
  if (status === 401) return 'Your session ended. Sign in again, then try again.';
  if (status === 403) return 'This needs an admin account.';
  const errors = Array.isArray(body?.errors) ? (body.errors as unknown[]) : [];
  for (const issue of errors) {
    if (typeof issue !== 'object' || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof path !== 'string' || typeof message !== 'string') continue;
    const index = /^images\.(\d+)$/.exec(path)?.[1];
    const name = index === undefined ? 'A photo' : (names[Number(index)] ?? 'A photo');
    if (message.includes('MB')) return `${name} is larger than ${MEGABYTES} MB.`;
    if (path.startsWith('images')) {
      return path === 'images'
        ? `Choose 1 to ${LISTING_UPLOAD_LIMITS.maxImages} photos.`
        : `${name} isn't a JPEG, PNG or WebP.`;
    }
    if (path === 'hints') return `Notes can be up to ${LISTING_UPLOAD_LIMITS.maxHintsLength} characters.`;
  }
  if (status === 413) return `A photo is larger than ${MEGABYTES} MB.`;
  if (status === 415 || status === 422) return "A photo isn't a JPEG, PNG or WebP.";
  return "Couldn't upload the photos. Check your connection and try again.";
}
