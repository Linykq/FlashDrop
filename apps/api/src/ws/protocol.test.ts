import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canSubscribe, principalOf } from './access';
import { parseClientMessage, parseJson, textOf } from './protocol';

const DROP = '5eed0004-0000-4000-8000-000000000001';

describe('textOf', () => {
  it('reads every shape ws hands over', () => {
    expect(textOf(Buffer.from('{"a":1}'))).toBe('{"a":1}');
    expect(textOf([Buffer.from('{"a"'), Buffer.from(':1}')])).toBe('{"a":1}');
    expect(textOf(new TextEncoder().encode('ünï').buffer)).toBe('ünï');
  });
});

describe('parseJson', () => {
  it('is null for invalid JSON and for values the schema refuses', () => {
    const Schema = z.object({ n: z.int() });
    expect(parseJson(Schema, '{"n":1}')).toEqual({ n: 1 });
    expect(parseJson(Schema, '{"n":')).toBeNull();
    expect(parseJson(Schema, '{"n":"1"}')).toBeNull();
  });

  it('validates client frames with the protocol schema', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'sub', topics: [`stock:${DROP}`] }))).toEqual({
      type: 'sub',
      topics: [`stock:${DROP}`],
    });
    expect(parseClientMessage(JSON.stringify({ type: 'sub', topics: [`stock:${DROP}`], extra: 1 }))).toEqual({
      type: 'sub',
      topics: [`stock:${DROP}`],
    });
    expect(parseClientMessage(JSON.stringify({ type: 'sub', topics: `stock:${DROP}` }))).toBeNull();
  });
});

describe('access (§7, §11)', () => {
  it('maps a session to a user, with its expiry in ms, and no session to a fresh anonymous id', () => {
    expect(principalOf({ sub: DROP, role: 'admin', name: 'Mira Chen', exp: 1_791_000_000 })).toEqual({
      kind: 'user',
      userId: DROP,
      role: 'admin',
      expiresAt: 1_791_000_000_000,
    });
    const [first, second] = [principalOf(null), principalOf(null)];
    expect(first.kind).toBe('anonymous');
    expect(first).not.toEqual(second);
  });

  it('opens stock and room to everyone and dash to admins only', () => {
    const anonymous = principalOf(null);
    const buyer = principalOf({ sub: DROP, role: 'buyer', name: 'Ada', exp: 1_791_000_000 });
    const admin = principalOf({ sub: DROP, role: 'admin', name: 'Mira', exp: 1_791_000_000 });
    for (const principal of [anonymous, buyer, admin]) {
      expect(canSubscribe(principal, 'stock')).toBe(true);
      expect(canSubscribe(principal, 'room')).toBe(true);
    }
    expect([anonymous, buyer, admin].map((principal) => canSubscribe(principal, 'dash'))).toEqual([
      false,
      false,
      true,
    ]);
  });
});
