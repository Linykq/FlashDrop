import { BugError } from '@flashdrop/domain';
import { describe, expect, it } from 'vitest';
import { canonicalUuid, dropKeys, rateLimitKey, stockChannel, userChannel } from './keys';

const DROP = '5EED0004-0000-4000-8000-000000000001';

/** The part of a key Redis Cluster hashes: the first `{...}`. */
const hashTag = (key: string) => /\{([^}]*)\}/.exec(key)?.[1];

describe('dropKeys', () => {
  it('builds the §4.1 keys from the lowercased id, all in the drop hash tag', () => {
    const keys = dropKeys(DROP);
    const id = DROP.toLowerCase();

    expect(keys).toEqual({
      dropId: id,
      inv: `fd:{d:${id}}:inv`,
      rsv: `fd:{d:${id}}:rsv`,
      uq: `fd:{d:${id}}:uq`,
      exp: `fd:{d:${id}}:exp`,
    });
    const tags = new Set([keys.inv, keys.rsv, keys.uq, keys.exp, stockChannel(DROP)].map(hashTag));
    expect(tags).toEqual(new Set([`d:${id}`]));
  });

  it('refuses anything but a uuid, so no id can move a key out of its slot', () => {
    expect(() => dropKeys('abc}:inv')).toThrow(BugError);
    expect(() => dropKeys('')).toThrow(BugError);
    expect(() => userChannel('anon:1')).toThrow(BugError);
    expect(() => canonicalUuid('rid', 'not-a-uuid')).toThrow(BugError);
  });
});

describe('channels and other keys', () => {
  it('match the names the Functions and the gateway use', () => {
    const id = DROP.toLowerCase();

    expect(stockChannel(DROP)).toBe(`fd:ch:stock:{d:${id}}`);
    expect(userChannel(DROP)).toBe(`fd:ch:user:${id}`);
  });

  it('builds rate-limit keys for users and IPv4/IPv6 addresses, never with a colon in the route', () => {
    expect(rateLimitKey('reserve-user', DROP)).toBe(`fd:rl:reserve-user:${DROP}`);
    expect(rateLimitKey('reserve-ip', '::1')).toBe('fd:rl:reserve-ip:::1');
    expect(() => rateLimitKey('a:b', 'x')).toThrow(BugError);
    expect(() => rateLimitKey('route', 'has space')).toThrow(BugError);
  });
});
