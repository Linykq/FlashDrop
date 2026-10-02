import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { DevUsersResponse, MeResponse, ProblemDetails } from '@flashdrop/contracts';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../http/api';
import { createSessionCodec, SESSION_TTL_SECONDS } from '../http/session';
import { ADMIN, BUYER, buildTestApp, type FakeState, fakeState, ORIGIN, SECRET } from '../test/fakes';

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
    expect(claims).toEqual({ sub: BUYER.id, role: 'buyer', name: BUYER.displayName });
  });

  it('marks the cookie Secure behind an https edge', async () => {
    const response = await login(BUYER.id, { origin: ORIGIN, 'x-forwarded-proto': 'https' });
    expect(response.cookies[0]?.secure).toBe(true);
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
    const expired = await new SignJWT({ role: 'buyer', name: BUYER.displayName })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(BUYER.id)
      .setIssuedAt(0)
      .setExpirationTime(1)
      .sign(new TextEncoder().encode(SECRET));
    for (const bad of [`${header}.${forgedPayload}.${signature}`, foreign, expired, 'garbage']) {
      expect((await me(bad)).statusCode).toBe(401);
    }
  });

  it('answers 401 when the user no longer exists', async () => {
    const token = await sessionCookie(BUYER.id);
    state.users.delete(BUYER.id);
    expect((await me(token)).statusCode).toBe(401);
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
