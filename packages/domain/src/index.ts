/**
 * @packageDocumentation
 * Pure domain logic with no I/O: the closed value sets of the data model, the order state machine (design
 * §4.4), drop lifecycle rules, the reservation vocabulary (Lua replies, refusals and their API codes,
 * replays, §4.5 and §5.2), Idempotency-Key validation, stock arithmetic, canonical JSON and the typed errors
 * every layer throws.
 *
 * Reservation ids, event ids and request fingerprints (§4.5) need `node:crypto`, so they live behind their own entry
 * point, `@flashdrop/domain/identity`: this one also reaches browser bundles through the contracts.
 */
export * from './alerts';
export * from './canonical-json';
export * from './drops';
export * from './errors';
export * from './idempotency';
export * from './order-state';
export * from './reservation';
export * from './statuses';
export * from './stock';
