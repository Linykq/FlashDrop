/**
 * An RFC 9562 version-7 uuid made in the browser: 48 bits of Unix milliseconds, then random bits from
 * `crypto.getRandomValues`. `@flashdrop/domain/identity` has the Node version, which needs `node:crypto`.
 * The Buy button uses it for its Idempotency-Key (SD §8.2): 74 random bits keep two buyers' keys apart, and
 * the time prefix sorts one buyer's attempts in api's logs. Every uuid fits the key format (36 characters
 * of hex digits and hyphens).
 */
export function uuidv7(now: number = Date.now()): string {
  const time = now.toString(16).padStart(12, '0');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  // The version nibble is 7; the variant's top two bits are 10, so its nibble is 8, 9, a or b.
  const variant = ((Number.parseInt(random.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}
