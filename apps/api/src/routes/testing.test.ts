import { randomUUID } from 'node:crypto';
import type { SessionUser, TestDropBody } from '@flashdrop/contracts';
import { TestDropResponse, TestSessionsResponse } from '@flashdrop/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { Api } from '../http/api';
import { createSessionCodec } from '../http/session';
import type { TestRouteService } from '../services/testing';
import { buildTestApp, ORIGIN, SECRET } from '../test/fakes';

const TEST_SECRET = 'test-routes-secret-for-unit-tests';
const DROP = {
  dropId: randomUUID(),
  productId: randomUUID(),
  productSlug: 'test-drop-0123456789abcdef',
  startsAt: '2026-10-02T12:00:00.000Z',
  endsAt: '2026-10-02T13:00:00.000Z',
};

let app: Api | undefined;
afterEach(() => app?.close());

function service(drops: TestDropBody[]): TestRouteService {
  return {
    createBuyers: async (count) =>
      Array.from(
        { length: count },
        (_, i): SessionUser => ({
          id: randomUUID(),
          email: `load-${i}@load.test`,
          displayName: `Load buyer ${i}`,
          role: 'buyer',
        }),
      ),
    createArmedDrop: async (body) => {
      drops.push(body);
      return DROP;
    },
  };
}

const post = (api: Api, url: string, payload: object, secret: string | null = TEST_SECRET) =>
  api.inject({
    method: 'POST',
    url: `/api/v1/test/${url}`,
    headers: { origin: ORIGIN, ...(secret === null ? {} : { 'x-test-secret': secret }) },
    payload,
  });

describe('test routes', () => {
  it('mint a valid buyer session for each fresh user', async () => {
    app = await buildTestApp({ testRoutes: { secret: TEST_SECRET, service: service([]) } });
    const response = await post(app, 'sessions', { count: 3 });
    expect(response.statusCode).toBe(200);
    const { sessions } = TestSessionsResponse.parse(response.json());
    expect(sessions).toHaveLength(3);
    const codec = createSessionCodec(SECRET);
    for (const session of sessions) {
      expect(await codec.verify(session.token)).toMatchObject({ sub: session.userId, role: 'buyer' });
    }
  });

  it('create an armed drop with the defaults filled in: 201', async () => {
    const drops: TestDropBody[] = [];
    app = await buildTestApp({ testRoutes: { secret: TEST_SECRET, service: service(drops) } });
    const response = await post(app, 'drops', {
      stock: 5,
      perUserLimit: 1,
      holdSeconds: 10,
      paymentSeconds: 30,
    });
    expect(response.statusCode).toBe(201);
    expect(TestDropResponse.parse(response.json())).toEqual(DROP);
    expect(drops).toEqual([
      {
        stock: 5,
        perUserLimit: 1,
        holdSeconds: 10,
        paymentSeconds: 30,
        durationSeconds: 3600,
        priceCents: 2500,
      },
    ]);
  });

  it('refuse a call without the secret or with a wrong one', async () => {
    app = await buildTestApp({ testRoutes: { secret: TEST_SECRET, service: service([]) } });
    expect((await post(app, 'sessions', { count: 1 }, null)).statusCode).toBe(403);
    expect((await post(app, 'sessions', { count: 1 }, `${TEST_SECRET}x`)).statusCode).toBe(403);
    expect((await post(app, 'sessions', { count: 0 })).statusCode).toBe(400);
  });

  it('do not exist unless ENABLE_TEST_ROUTES mounted them', async () => {
    app = await buildTestApp();
    expect((await post(app, 'sessions', { count: 1 })).statusCode).toBe(404);
    expect((await post(app, 'drops', { stock: 1 })).statusCode).toBe(404);
  });
});
