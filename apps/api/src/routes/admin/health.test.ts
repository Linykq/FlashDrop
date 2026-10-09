import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { AdminHealthResponse, type SessionUser } from '@flashdrop/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../../http/api';
import {
  ADMIN,
  BUYER,
  buildTestApp,
  type FakeState,
  fakeState,
  HEALTH,
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

describe('GET /admin/health (§12)', () => {
  it('serves the live checks to an admin, never cached', async () => {
    const response = await get('/admin/health');

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(AdminHealthResponse.parse(response.json())).toEqual(HEALTH);
  });

  it('lists a breach with the drop and order it concerns', async () => {
    const [first, ...rest] = HEALTH.invariants;
    if (first === undefined) throw new Error('no invariants');
    const breach = {
      dropId: LIVE_DROP.id,
      orderId: '0192a3b4-0000-4000-8000-0000000000a1',
      message: 'reserved 3 + sold 248 > total 250',
    };
    state.health = {
      ...HEALTH,
      invariants: [{ ...first, status: 'breached', violations: [breach] }, ...rest],
    };

    const body = AdminHealthResponse.parse((await get('/admin/health')).json());

    expect(body.invariants[0]).toMatchObject({ id: 'INV-1', status: 'breached', violations: [breach] });
  });

  it('is 401 without a session and 403 for a buyer', async () => {
    expect((await get('/admin/health', null)).statusCode).toBe(401);
    expect((await get('/admin/health', BUYER)).statusCode).toBe(403);
  });
});
