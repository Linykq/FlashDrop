/**
 * @packageDocumentation
 * Pure domain logic with no I/O: the closed value sets of the data model, the order state machine (design
 * §4.4), stock arithmetic, canonical JSON and the typed errors every layer throws.
 *
 * Name-based ids and request fingerprints (§4.5) need `node:crypto`, so they live behind their own entry
 * point, `@flashdrop/domain/identity`: this one also reaches browser bundles through the contracts.
 */
export * from './canonical-json';
export * from './errors';
export * from './order-state';
export * from './statuses';
export * from './stock';
