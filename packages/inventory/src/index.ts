/**
 * @packageDocumentation
 * Redis admission (design §4): the `flashdrop` Functions library and its typed calls, key builders, the
 * per-drop lock, `syncDropFromPostgres` (arm and rebuild under the generation fence, §4.7), `settleRedis`
 * (§6.5), and the helpers the sweeper, the reconciler and `verify:invariants` build on.
 */
export { fdConfirm, fdRateLimitHit, fdRebuild, fdRelease, fdReserve, fdSetStatus } from './calls';
export {
  type CommandClientOptions,
  connectCommandClient,
  createCommandClient,
  createSubscriber,
  type FlashdropRedis,
  isTransientRedisError,
  type RedisClientOptions,
  type SubscriberOptions,
} from './client';
export { BULK_DEADLINE_MS, REDIS_DEADLINE_MS, RedisDeadlineError, withDeadline } from './deadline';
export {
  assertDropLockHeld,
  DROP_LOCK_POOL_PROFILE,
  DROP_LOCK_TIMEOUT_MS,
  type DropLockDeps,
  type HeldDropLock,
  tryWithDropLock,
  withDropLock,
} from './drop-lock';
export {
  commitRedisIdentity,
  type EpochOptions,
  type KeyspaceLoss,
  keyspaceLoss,
  type LiveRedisIdentity,
  readLiveRedisIdentity,
  readStoredRedisIdentity,
  type StoredRedisIdentity,
} from './epoch';
export type { ReserveInput } from './functions';
export {
  deferHoldExpiry,
  HOLD_GRACE_MS,
  listExpiredHolds,
  type StructuralIssue,
  structuralIssue,
} from './holds';
export {
  type DropKeys,
  dashboardChannel,
  dropKeys,
  EPOCH_KEY,
  rateLimitKey,
  roomChannel,
  stockChannel,
  userChannel,
  viewersKey,
} from './keys';
export {
  LIBRARY_NAME,
  LIBRARY_VERSION,
  type LibraryState,
  type LoadLibraryOptions,
  libraryState,
  loadLibrary,
} from './library';
export { createSyncNudger, SYNC_CHANNEL, type SyncNudger } from './nudge';
export {
  type RateLimitHit,
  REDIS_DROP_STATUSES,
  RESERVE_REFUSALS,
  type RebuildResult,
  type RedisDropStatus,
  type ReserveRefusal,
  type ReserveResult,
  type SetStatusResult,
  type SettleReply,
  type SettleResult,
} from './replies';
export {
  type ApplyOutcome,
  applySettlement,
  type SettleDeps,
  type SettledVia,
  type SettleOutcome,
  settleRedis,
  type TerminalOrderRef,
} from './settle';
export {
  type RedisDropState,
  type RedisInv,
  type RedisRsvEntry,
  type RedisStock,
  readDropState,
  readStock,
  redisDropViolations,
} from './state';
export {
  compareStockVersions,
  parseStockMessage,
  type StockLevelMessage,
  type StockVersion,
} from './stock-message';
export { rebuildDrop, type SyncDeps, type SyncOutcome, syncDropFromPostgres } from './sync';
