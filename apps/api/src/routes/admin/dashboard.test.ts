import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { AdminDashboardResponse, type SessionUser } from '@flashdrop/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../../http/api';
import {
  ADMIN,
  BUYER,
  buildTestApp,
  DASHBOARD,
  type FakeState,
  fakeState,
  LIVE_DROP,
  sessionToken,
} from '../../test/fakes';

let app: Api;
let state: FakeState;

beforeEach(async () => {
  state = fakeState();
  app = await buildTestApp({}, state);
});
afterEach(() => app.close());

async function get(url: string, user: SessionUser | null = ADMIN) {
  return app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    cookies: user === null ? {} : { [SESSION_COOKIE]: await sessionToken(user) },
  });
}

describe('GET /admin/dashboard/drops/:dropId (§9)', () => {
  it('serves the drop’s dashboard to an admin, never cached', async () => {
    const response = await get(`/admin/dashboard/drops/${LIVE_DROP.id}`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(AdminDashboardResponse.parse(response.json())).toEqual(DASHBOARD);
  });

  it('is 401 without a session and 403 for a buyer', async () => {
    expect((await get(`/admin/dashboard/drops/${LIVE_DROP.id}`, null)).statusCode).toBe(401);
    expect((await get(`/admin/dashboard/drops/${LIVE_DROP.id}`, BUYER)).statusCode).toBe(403);
  });

  it('is 404 for an unknown drop and 400 for a malformed id', async () => {
    expect((await get('/admin/dashboard/drops/5eed0004-0000-4000-8000-0000000000ff')).statusCode).toBe(404);
    expect((await get('/admin/dashboard/drops/not-a-uuid')).statusCode).toBe(400);
  });
});
