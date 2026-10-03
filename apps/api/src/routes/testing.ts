import { createHash, timingSafeEqual } from 'node:crypto';
import {
  TEST_SECRET_HEADER,
  TestDropBody,
  TestDropResponse,
  TestSessionsBody,
  TestSessionsResponse,
} from '@flashdrop/contracts';
import { DomainError } from '@flashdrop/domain';
import type { onRequestAsyncHookHandler } from 'fastify';
import type { Api } from '../http/api';
import type { SessionCodec } from '../http/session';
import type { TestRouteService } from '../services/testing';

export interface TestRouteDeps {
  readonly service: TestRouteService;
  readonly sessions: SessionCodec;
  /** `TEST_ROUTES_SECRET`. */
  readonly secret: string;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Every call must carry `x-test-secret`; compared in constant time (equal-length digests). */
function testSecretGuard(secret: string): onRequestAsyncHookHandler {
  const expected = digest(secret);
  return async (request) => {
    const given = request.headers[TEST_SECRET_HEADER];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), expected)) {
      throw new DomainError('FORBIDDEN', `${TEST_SECRET_HEADER} required`);
    }
  };
}

/**
 * Test-only routes (design §5.1, §13), mounted only with `ENABLE_TEST_ROUTES=true`: sessions for k6 and an
 * isolated, armed drop per Playwright spec. Mutating, so callers also send an allowed `Origin`.
 */
export function testRoutes(app: Api, { service, sessions, secret }: TestRouteDeps): void {
  const guard = testSecretGuard(secret);

  app.post(
    '/test/sessions',
    { onRequest: guard, schema: { body: TestSessionsBody, response: { 200: TestSessionsResponse } } },
    async (request) => {
      const buyers = await service.createBuyers(request.body.count);
      return {
        sessions: await Promise.all(
          buyers.map(async (buyer) => ({ userId: buyer.id, token: await sessions.issue(buyer) })),
        ),
      };
    },
  );

  app.post(
    '/test/drops',
    { onRequest: guard, schema: { body: TestDropBody, response: { 201: TestDropResponse } } },
    async (request, reply) => {
      reply.code(201);
      return service.createArmedDrop(request.body);
    },
  );
}
