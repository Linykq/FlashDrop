/**
 * Joins class names, skipping falsy parts. Deliberately not tailwind-merge: it would need configuring to tell
 * `text-body` (a size) from `text-label` (a colour), and primitives never let callers override their styling
 * anyway (`className` is for layout only).
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
