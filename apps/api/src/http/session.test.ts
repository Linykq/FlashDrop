import { SESSION_AUDIENCE, SESSION_ISSUER, SESSION_TTL_SECONDS } from '@flashdrop/config/constants';
import type { SessionClaims, SessionUser, UserRole } from '@flashdrop/contracts';
import { decodeProtectedHeader, SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createAdminRoleCheck, createSessionCodec } from './session';

const SECRET = 'test-session-secret-at-least-32-chars';
const KEY = new TextEncoder().encode(SECRET);
const USER: SessionUser = {
  id: '5eed0001-0000-4000-8000-000000000001',
  email: 'mira@example.test',
  displayName: 'Mira Chen',
  role: 'admin',
};
const codec = createSessionCodec(SECRET);

describe('createSessionCodec', () => {
  it('round-trips the claims of an HS256 token that lives 12 hours', async () => {
    const token = await codec.issue(USER);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256', typ: 'JWT' });
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    // `exp` is kept: the gateway closes a socket whose session expired.
    expect(await codec.verify(token)).toEqual({
      sub: USER.id,
      role: 'admin',
      name: 'Mira Chen',
      exp: payload.exp,
    });
    expect(payload.exp - payload.iat).toBe(SESSION_TTL_SECONDS);
    expect(payload).toMatchObject({ iss: SESSION_ISSUER, aud: SESSION_AUDIENCE });
  });

  it('rejects an unsigned token (alg: none)', async () => {
    const unsigned = new UnsecuredJWT({ role: 'admin', name: 'x' }).setSubject(USER.id).encode();
    expect(await codec.verify(unsigned)).toBeNull();
  });

  it('rejects a token signed with another algorithm', async () => {
    const hs512 = await new SignJWT({ role: 'admin', name: 'x' })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(USER.id)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET.repeat(2)));
    expect(await codec.verify(hs512)).toBeNull();
  });

  it('rejects valid signatures over claims that are not SessionClaims', async () => {
    const wrongRole = await new SignJWT({ role: 'root', name: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER.id)
      .setExpirationTime('1h')
      .sign(KEY);
    expect(await codec.verify(wrongRole)).toBeNull();
    // A session that never expires would keep a WebSocket subscribed forever.
    const endless = await new SignJWT({ role: 'admin', name: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER.id)
      .sign(KEY);
    expect(await codec.verify(endless)).toBeNull();
  });

  it('rejects malformed input', async () => {
    for (const token of ['', 'a.b.c', 'not a jwt']) expect(await codec.verify(token)).toBeNull();
  });
});

describe('createAdminRoleCheck', () => {
  const claims = (role: UserRole): SessionClaims => ({ sub: USER.id, role, name: 'Mira Chen', exp: 1 });

  it('takes buyer claims as they are, without a lookup', async () => {
    const lookup = vi.fn(async (): Promise<UserRole | undefined> => 'admin');
    expect(await createAdminRoleCheck(lookup)(claims('buyer'))).toEqual(claims('buyer'));
    expect(lookup).not.toHaveBeenCalled();
  });

  it("replaces an admin's role with the account's, and drops the session of a missing account", async () => {
    const roles = new Map<string, UserRole>([[USER.id, 'buyer']]);
    const check = createAdminRoleCheck(async (id) => roles.get(id));
    expect(await check(claims('admin'))).toEqual(claims('buyer'));
    roles.clear();
    expect(await createAdminRoleCheck(async (id) => roles.get(id))(claims('admin'))).toBeNull();
  });

  it('remembers a role for the TTL, then looks it up again', async () => {
    let now = 0;
    const lookup = vi.fn(async (): Promise<UserRole | undefined> => 'admin');
    const check = createAdminRoleCheck(lookup, { ttlMs: 30_000, now: () => now });
    await check(claims('admin'));
    now = 29_999;
    await check(claims('admin'));
    expect(lookup).toHaveBeenCalledTimes(1);
    now = 30_000;
    await check(claims('admin'));
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('keeps at most maxEntries accounts, dropping the least recently looked up', async () => {
    const lookup = vi.fn(async (): Promise<UserRole | undefined> => 'admin');
    const check = createAdminRoleCheck(lookup, { maxEntries: 2 });
    const of = (sub: string): SessionClaims => ({ ...claims('admin'), sub });
    const [a, b, c] = ['a', 'b', 'c'] as const;
    for (const sub of [a, b, c, b, c]) await check(of(sub));
    expect(lookup).toHaveBeenCalledTimes(3);
    await check(of(a));
    expect(lookup).toHaveBeenCalledTimes(4);
  });
});
