import {
  SESSION_AUDIENCE,
  SESSION_COOKIE,
  SESSION_ISSUER,
  SESSION_TTL_SECONDS,
} from '@flashdrop/config/constants';
import { DevUsersResponse, MeResponse, ProblemDetails } from '@flashdrop/contracts';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../http/api';
import { createSessionCodec } from '../http/session';
import { ADMIN, BUYER, buildTestApp, type FakeState, fakeState, ORIGIN, SECRET } from '../test/fakes';
import { DEV_LOGIN_PER_MINUTE } from './auth';

let app: Api;
let state: FakeState;

beforeEach(async () => {
  state = fakeState();
  app = await buildTestApp({}, state);
});
afterEach(() => app.close());

const login = (userId: string, headers: Record<string, string> = { origin: ORIGIN }) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', headers, payload: { userId } });

async function sessionCookie(userId: string): Promise<string> {
  const response = await login(userId);
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  if (cookie === undefined) throw new Error('dev-login set no session cookie');
  return cookie.value;
}

const me = (token?: string) =>
  app.inject({ url: '/api/v1/me', cookies: token === undefined ? {} : { [SESSION_COOKIE]: token } });

describe('without ENABLE_DEV_LOGIN', () => {
  it('serves neither dev-login route, so no one can sign in without a password', async () => {
    const closed = await buildTestApp({ devLogin: false }, state);
    try {
      expect((await closed.inject({ url: '/api/v1/auth/dev-users' })).statusCode).toBe(404);
      const response = await closed.inject({
        method: 'POST',
        url: '/api/v1/auth/dev-login',
        headers: { origin: ORIGIN },
        payload: { userId: ADMIN.id },
      });
      expect(response.statusCode).toBe(404);
      expect(response.cookies).toEqual([]);
      // Signing out and the session's user stay: they need no dev login.
      expect((await closed.inject({ url: '/api/v1/me' })).statusCode).toBe(401);
    } finally {
      await closed.close();
    }
  });
});

describe('GET /api/v1/auth/dev-users', () => {
  it('lists the seeded accounts', async () => {
    const response = await app.inject({ url: '/api/v1/auth/dev-users' });
    expect(response.statusCode).toBe(200);
    expect(DevUsersResponse.parse(response.json()).users).toEqual([ADMIN, BUYER]);
  });
});

describe('POST /api/v1/auth/dev-login', () => {
  it('answers 204 with an HttpOnly, SameSite=Lax session cookie valid for 12 h', async () => {
    const response = await login(BUYER.id);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    const [cookie] = response.cookies;
    expect(cookie).toMatchObject({
      name: SESSION_COOKIE,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: SESSION_TTL_SECONDS,
    });
    expect(cookie?.secure).toBeUndefined();
    const claims = await createSessionCodec(SECRET).verify(cookie?.value ?? '');
    expect(claims).toEqual({
      sub: BUYER.id,
      role: 'buyer',
      name: BUYER.displayName,
      exp: expect.any(Number),
    });
  });

  it('marks the cookie Secure by COOKIE_SECURE, never by a forwarded scheme the edge rewrites', async () => {
    const forwarded = await login(BUYER.id, { origin: ORIGIN, 'x-forwarded-proto': 'https' });
    expect(forwarded.cookies[0]?.secure).toBeUndefined();

    const secure = await buildTestApp({ cookieSecure: true }, state);
    try {
      const response = await secure.inject({
        method: 'POST',
        url: '/api/v1/auth/dev-login',
        headers: { origin: ORIGIN },
        payload: { userId: BUYER.id },
      });
      expect(response.cookies[0]).toMatchObject({ name: SESSION_COOKIE, secure: true, httpOnly: true });
      const logout = await secure.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { origin: ORIGIN },
      });
      expect(logout.cookies[0]).toMatchObject({ name: SESSION_COOKIE, secure: true, maxAge: 0 });
    } finally {
      await secure.close();
    }
  });

  it(`allows ${DEV_LOGIN_PER_MINUTE} logins a minute per client address, then 429`, async () => {
    for (let i = 0; i < DEV_LOGIN_PER_MINUTE; i++) expect((await login(BUYER.id)).statusCode).toBe(204);
    const limited = await login(BUYER.id);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.cookies).toEqual([]);
  });

  // Regression: every private-network peer was trusted to name the client in X-Forwarded-For, so any
  // container could pick a fresh address per request and dodge the per-IP limits.
  it('counts an untrusted peer as the client, whatever X-Forwarded-For it claims (TRUST_PROXY)', async () => {
    const from = (remoteAddress: string, i: number) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/dev-login',
        remoteAddress,
        headers: { origin: ORIGIN, 'x-forwarded-for': `203.0.113.${i}` },
        payload: { userId: BUYER.id },
      });
    const statuses = [];
    for (let i = 0; i <= DEV_LOGIN_PER_MINUTE; i++) statuses.push((await from('10.0.0.5', i)).statusCode);
    expect(statuses.at(-1)).toBe(429);

    // The trusted edge (loopback here) does name the client: each forwarded address has its own window.
    for (let i = 0; i <= DEV_LOGIN_PER_MINUTE; i++) expect((await from('127.0.0.1', i)).statusCode).toBe(204);
  });

  it('answers 404 for an account that is not a seeded dev user', async () => {
    const response = await login('11111111-1111-4111-8111-111111111111');
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(ProblemDetails.parse(response.json())).toMatchObject({
      code: 'NOT_FOUND',
      detail: 'User not found',
    });
    expect(response.cookies).toEqual([]);
  });

  it('rejects a body that is not { userId: uuid }', async () => {
    const response = await login('not-a-uuid');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: 'Invalid body',
      errors: [{ path: 'userId', message: 'Invalid UUID' }],
    });
  });

  it('rejects a missing body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: '' }] });
  });

  it.each([
    ['no Origin', {}],
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['an Origin with a path', { origin: `${ORIGIN}/` }],
  ])('refuses a request with %s (CSRF)', async (_case, headers: Record<string, string>) => {
    const response = await login(BUYER.id, headers);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(response.cookies).toEqual([]);
  });

  it('accepts JSON only: a text/plain body (a cross-site form can send one) is refused', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      headers: { origin: ORIGIN, 'content-type': 'text/plain' },
      payload: JSON.stringify({ userId: BUYER.id }),
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ status: 415, code: 'VALIDATION_FAILED' });
  });

  it('answers malformed JSON with a 400 problem', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: '{"userId":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('GET /api/v1/me', () => {
  it('returns the signed-in user, never cached', async () => {
    const response = await me(await sessionCookie(ADMIN.id));
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(MeResponse.parse(response.json())).toEqual({ user: ADMIN });
  });

  it('answers 401 without a session', async () => {
    const response = await me();
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('answers 401 for a tampered, foreign or expired token', async () => {
    const token = await sessionCookie(BUYER.id);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: BUYER.id, role: 'admin', name: 'x' })).toString(
      'base64url',
    );
    const foreign = await createSessionCodec('another-secret-that-is-32-chars-long').issue(BUYER);
    const key = new TextEncoder().encode(SECRET);
    const signed = (claims: { iss?: string; aud?: string; iat: number; exp: number }) => {
      const jwt = new SignJWT({ role: 'buyer', name: BUYER.displayName })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(BUYER.id)
        .setIssuedAt(claims.iat)
        .setExpirationTime(claims.exp);
      if (claims.iss !== undefined) jwt.setIssuer(claims.iss);
      if (claims.aud !== undefined) jwt.setAudience(claims.aud);
      return jwt.sign(key);
    };
    const now = Math.floor(Date.now() / 1000);
    const ours = { iss: SESSION_ISSUER, aud: SESSION_AUDIENCE };
    const bad = [
      `${header}.${forgedPayload}.${signature}`,
      foreign,
      'garbage',
      await signed({ ...ours, iat: 0, exp: 1 }),
      // Signed with the right key, but not a session: no issuer and audience, or another audience.
      await signed({ iat: now, exp: now + 60 }),
      await signed({ ...ours, aud: 'another-service', iat: now, exp: now + 60 }),
      // Unexpired, but issued longer ago than a session lives.
      await signed({ ...ours, iat: now - SESSION_TTL_SECONDS - 60, exp: now + 3_600 }),
    ];
    for (const token of bad) expect((await me(token)).statusCode).toBe(401);
  });

  it('answers 401 when the user no longer exists', async () => {
    const token = await sessionCookie(BUYER.id);
    state.users.delete(BUYER.id);
    expect((await me(token)).statusCode).toBe(401);
  });
});

describe('admin claims', () => {
  const adminHealth = (token: string) =>
    app.inject({ url: '/api/v1/admin/health', cookies: { [SESSION_COOKIE]: token } });

  it('are confirmed against the account: a demoted admin is a buyer on the next request', async () => {
    const token = await sessionCookie(ADMIN.id);
    state.users.set(ADMIN.id, { ...ADMIN, role: 'buyer' });
    const response = await adminHealth(token);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('count for nothing when the account does not exist', async () => {
    const token = await createSessionCodec(SECRET).issue({
      ...ADMIN,
      id: '11111111-1111-4111-8111-111111111111',
    });
    expect((await adminHealth(token)).statusCode).toBe(401);
  });

  it('let a current admin through', async () => {
    expect((await adminHealth(await sessionCookie(ADMIN.id))).statusCode).toBe(200);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('clears the cookie with the same attributes it was set with', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(204);
    expect(response.cookies[0]).toMatchObject({
      name: SESSION_COOKIE,
      value: '',
      maxAge: 0,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
  });

  it('is a mutating request: Origin is required', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(response.statusCode).toBe(403);
  });
});
