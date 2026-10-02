/**
 * `JSON.stringify` with object keys sorted at every level, so equal values always serialize to the same
 * bytes. Request fingerprints hash it (design §4.5): `{qty, dropId}` and `{dropId, qty}` must collide.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  // Dates and other objects with toJSON keep their own serialization.
  if (value === null || typeof value !== 'object' || 'toJSON' in value) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sortKeys(entry)]),
  );
}
