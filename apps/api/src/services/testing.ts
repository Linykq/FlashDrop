import type { SessionUser, TestDropBody, TestDropResponse } from '@flashdrop/contracts';
import { createTestBuyers, createTestDrop, type Db } from '@flashdrop/db';
import type { AdminDropService } from './admin-drops';

/**
 * Behind the test-only routes (design §5.1, §13): fresh buyers for k6 sessions, and an isolated drop per
 * Playwright spec, armed through the admin path so tests exercise the real arm and sync.
 */
export interface TestRouteService {
  createBuyers(count: number): Promise<SessionUser[]>;
  createArmedDrop(body: TestDropBody): Promise<TestDropResponse>;
}

export function createTestRouteService(deps: {
  readonly db: Db;
  readonly adminDrops: AdminDropService;
}): TestRouteService {
  return {
    createBuyers: (count) => createTestBuyers(deps.db, count),

    async createArmedDrop(body) {
      const { startsAt, ...settings } = body;
      const drop = await createTestDrop(deps.db, {
        ...settings,
        ...(startsAt === undefined ? {} : { startsAt: new Date(startsAt) }),
      });
      await deps.adminDrops.act(drop.dropId, 'arm');
      return {
        dropId: drop.dropId,
        productId: drop.productId,
        productSlug: drop.productSlug,
        startsAt: drop.startsAt.toISOString(),
        endsAt: drop.endsAt.toISOString(),
      };
    },
  };
}
