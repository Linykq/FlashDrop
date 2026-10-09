/*
 * What an admin reads when api refuses an action (design-system §12.2): what happened and what to do next,
 * with precise words allowed in admin (§12.1). Shared by Server Actions and the browser-side upload.
 */

/** A refusal as the UI shows it: a stable code to branch on, the sentence, and any field-level problems. */
export type ActionFailure = {
  readonly code: string;
  readonly message: string;
  /** VALIDATION_FAILED issues by dotted path (`priceCents`, `attributes.size`). */
  readonly fields?: Readonly<Record<string, string>>;
};

const MESSAGES: Readonly<Record<string, string>> = {
  DROP_ARMED: 'This drop is already armed. Refresh to see its current state.',
  DROP_BUSY: 'Another change to this drop is running. Try again in a moment.',
  CONFLICT: 'This changed since the page loaded. Refresh to see its current state.',
  NOT_FOUND: 'This no longer exists. Refresh the page.',
  UNAUTHENTICATED: 'Your session ended. Sign in again, then try again.',
  FORBIDDEN: 'This needs an admin account.',
  RATE_LIMITED: 'Too many tries. Wait a moment, then try again.',
  VALIDATION_FAILED: 'Some fields need attention.',
};

const UNREACHABLE = "Couldn't reach the server. Check your connection and try again.";
const UNEXPECTED = 'Something went wrong. Try again in a moment.';

/** The message for api's answer: its problem `code` when it sent one, else the HTTP status. */
export function failureOf(
  status: number,
  problem: { code: string; errors?: readonly { path: string; message: string }[] } | undefined,
): ActionFailure {
  if (status === 0) return { code: 'UNREACHABLE', message: UNREACHABLE };
  const code =
    problem?.code ?? (status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'INTERNAL');
  const fields = problem?.errors?.length
    ? Object.fromEntries(problem.errors.map((issue) => [issue.path, issue.message]))
    : undefined;
  return { code, message: MESSAGES[code] ?? UNEXPECTED, ...(fields ? { fields } : {}) };
}
