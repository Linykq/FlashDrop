/**
 * @packageDocumentation
 * Zod schemas for every boundary, shared by producers and consumers so both sides validate the same shape:
 * HTTP DTOs (design §5.1), the `OrderEvent` envelope (§6.2), the PSP mock's API (§6.5), the WebSocket
 * protocol (§7) and the `ListingWire` / `ListingDraft` LLM schemas (§10).
 */
export * from './admin';
export * from './admin-catalog';
export * from './auth';
export * from './catalog';
export * from './checkout';
export * from './common';
export * from './dashboard';
export * from './events';
export * from './health';
export * from './listing';
export * from './problem';
export * from './psp';
export * from './realtime';
export * from './reservations';
export * from './test-routes';
