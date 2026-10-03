import type { RebuildSnapshot } from '@flashdrop/db';
import { fingerprintHex } from '@flashdrop/domain/identity';
import type { CommandParser, RedisFunctions } from 'redis';
import { canonicalUuid, dropKeys } from './keys';
import {
  parseConfirmReply,
  parseRateLimitReply,
  parseRebuildReply,
  parseReleaseReply,
  parseReserveReply,
  parseSetStatusReply,
  type RedisDropStatus,
} from './replies';

/*
 * The typed definition of the `flashdrop` library for node-redis's `functions` client option (spike §1.2):
 * node-redis sends `FCALL <name> <NUMBER_OF_KEYS> ...` and exposes `client.flashdrop.<fn>(...args)` with the
 * argument list of `parseCommand` and the return type of `transformReply`. Keys are built only here, from
 * the drop id, so the key count cannot drift from the Lua signatures: Redis itself would run a Function
 * with a wrong key count and fail only at the first nil key (spike §1.1).
 *
 * No function is flagged `no-writes`, so all are called with FCALL, never FCALL_RO.
 */

export interface ReserveInput {
  readonly dropId: string;
  /** `reservationId(...)`: the `rsv` field and `orders.id`. */
  readonly rid: string;
  readonly userId: string;
  /** Validated 1–10 by Zod first; Lua answers `BAD_QTY` otherwise, which is a bug (§5.2). */
  readonly qty: number;
  /** `requestFingerprint({ dropId, qty })`, stored as `fp` and compared on every replay. */
  readonly fingerprint: Uint8Array;
  readonly idempotencyKey: string;
}

const flashdrop = {
  fd_reserve: {
    NUMBER_OF_KEYS: 4,
    parseCommand(parser: CommandParser, input: ReserveInput) {
      const k = dropKeys(input.dropId);
      parser.pushKeys([k.inv, k.rsv, k.uq, k.exp]);
      parser.push(
        k.dropId,
        canonicalUuid('rid', input.rid),
        canonicalUuid('userId', input.userId),
        String(input.qty),
        fingerprintHex(input.fingerprint),
        input.idempotencyKey,
      );
    },
    transformReply: parseReserveReply,
  },
  fd_confirm: {
    NUMBER_OF_KEYS: 3,
    parseCommand(parser: CommandParser, dropId: string, rid: string) {
      const k = dropKeys(dropId);
      parser.pushKeys([k.inv, k.rsv, k.exp]);
      parser.push(k.dropId, canonicalUuid('rid', rid));
    },
    transformReply: parseConfirmReply,
  },
  fd_release: {
    NUMBER_OF_KEYS: 4,
    parseCommand(parser: CommandParser, dropId: string, rid: string) {
      const k = dropKeys(dropId);
      parser.pushKeys([k.inv, k.rsv, k.uq, k.exp]);
      parser.push(k.dropId, canonicalUuid('rid', rid));
    },
    transformReply: parseReleaseReply,
  },
  fd_rebuild: {
    NUMBER_OF_KEYS: 4,
    parseCommand(parser: CommandParser, dropId: string, snapshot: RebuildSnapshot) {
      const k = dropKeys(dropId);
      parser.pushKeys([k.inv, k.rsv, k.uq, k.exp]);
      parser.push(k.dropId, JSON.stringify(snapshot));
    },
    transformReply: parseRebuildReply,
  },
  fd_set_status: {
    NUMBER_OF_KEYS: 1,
    parseCommand(parser: CommandParser, dropId: string, status: RedisDropStatus) {
      const k = dropKeys(dropId);
      parser.pushKey(k.inv);
      parser.push(k.dropId, status);
    },
    transformReply: parseSetStatusReply,
  },
  fd_rl_hit: {
    NUMBER_OF_KEYS: 1,
    /** `key` from `rateLimitKey(route, subject)`. */
    parseCommand(parser: CommandParser, key: string, windowMs: number) {
      parser.pushKey(key);
      parser.push(String(windowMs));
    },
    transformReply: parseRateLimitReply,
  },
} as const satisfies RedisFunctions[string];

/** The `functions` option of every FlashDrop Redis client. */
export const FLASHDROP_FUNCTIONS = { flashdrop } as const;
