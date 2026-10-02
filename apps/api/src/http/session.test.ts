import type { SessionUser } from '@flashdrop/contracts';
import { decodeProtectedHeader, SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createSessionCodec, SESSION_TTL_SECONDS } from './session';

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
    expect(await codec.verify(token)).toEqual({ sub: USER.id, role: 'admin', name: 'Mira Chen' });
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(SESSION_TTL_SECONDS);
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
  });

  it('rejects malformed input', async () => {
    for (const token of ['', 'a.b.c', 'not a jwt']) expect(await codec.verify(token)).toBeNull();
  });
});
