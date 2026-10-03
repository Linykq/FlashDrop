import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { AdminDropResponse } from '@flashdrop/contracts';
import { DomainError } from '@flashdrop/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../http/api';
import {
  ADMIN,
  ADMIN_DROP,
  BUYER,
  buildTestApp,
  type FakeState,
  fakeState,
  LIVE_DROP,
  ORIGIN,
  sessionToken,
} from '../test/fakes';

let app: Api;
let state: FakeState;

beforeEach(async () => {
  state = fakeState();
  app = await buildTestApp({}, state);
});
afterEach(() => app.close());

const CREATE = {
  productId: LIVE_DROP.product.id,
  startsAt: '2026-10-03T12:00:00.000Z',
  endsAt: '2026-10-03T13:00:00.000Z',
  priceCents: 2_500,
  stock: 100,
};

async function send(
  method: 'POST' | 'PATCH',
  url: string,
  payload?: object,
  user: typeof ADMIN | null = ADMIN,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { origin: ORIGIN },
    cookies: user === null ? {} : { [SESSION_COOKIE]: await sessionToken(user) },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe('admin drop routes', () => {
  it('create a DRAFT drop: 201 with the drop', async () => {
    const response = await send('POST', '/admin/drops', CREATE);
    expect(response.statusCode).toBe(201);
    expect(AdminDropResponse.parse(response.json())).toEqual({ drop: ADMIN_DROP });
    expect(state.admin.calls).toEqual(['create']);
  });

  it('patch a drop and run each action on it: 200 with the drop', async () => {
    const id = ADMIN_DROP.id;
    expect((await send('PATCH', `/admin/drops/${id}`, { stock: 50 })).statusCode).toBe(200);
    for (const action of ['arm', 'pause', 'resume', 'end', 'reconcile']) {
      const response = await send('POST', `/admin/drops/${id}/${action}`);
      expect(response.statusCode, action).toBe(200);
      expect(AdminDropResponse.parse(response.json()).drop.id).toBe(id);
    }
    expect(state.admin.calls).toEqual([
      `patch ${id}`,
      `arm ${id}`,
      `pause ${id}`,
      `resume ${id}`,
      `end ${id}`,
      `reconcile ${id}`,
    ]);
  });

  it.each([
    ['DROP_ARMED', 409],
    ['DROP_BUSY', 409],
    ['CONFLICT', 409],
    ['NOT_FOUND', 404],
  ] as const)('pass %s on as %i', async (code, status) => {
    state.admin.fail = new DomainError(code);
    const response = await send('POST', `/admin/drops/${ADMIN_DROP.id}/arm`);
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
  });

  it('refuse buyers with 403 and anonymous callers with 401, before any work', async () => {
    expect((await send('POST', '/admin/drops', CREATE, BUYER)).statusCode).toBe(403);
    expect((await send('POST', `/admin/drops/${ADMIN_DROP.id}/arm`, undefined, BUYER)).statusCode).toBe(403);
    expect((await send('PATCH', `/admin/drops/${ADMIN_DROP.id}`, { stock: 5 }, null)).statusCode).toBe(401);
    expect(state.admin.calls).toEqual([]);
  });

  it('validate bodies and ids: a window that ends first, an empty patch, an unknown action', async () => {
    const backwards = await send('POST', '/admin/drops', { ...CREATE, endsAt: CREATE.startsAt });
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().errors).toEqual([{ path: 'endsAt', message: 'endsAt must be after startsAt' }]);
    expect((await send('PATCH', `/admin/drops/${ADMIN_DROP.id}`, {})).statusCode).toBe(400);
    expect((await send('POST', '/admin/drops/42/arm')).statusCode).toBe(400);
    expect((await send('POST', `/admin/drops/${ADMIN_DROP.id}/delete`)).statusCode).toBe(404);
    expect(state.admin.calls).toEqual([]);
  });
});
