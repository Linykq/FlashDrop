/**
 * @packageDocumentation
 * Zod schemas for every boundary, shared by producers and consumers so both sides validate the same shape:
 * HTTP DTOs (design §5.1), the `OrderEvent` envelope (§6.2), the WebSocket protocol (§7) and the
 * `ListingWire` / `ListingDraft` LLM schemas (§10).
 */
export * from './auth';
export * from './catalog';
export * from './common';
export * from './health';
export * from './problem';
