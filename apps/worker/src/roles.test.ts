import { describe, expect, it } from 'vitest';
import { type RoleContext, RoleNotImplementedError, startRoles } from './roles';

// startRoles must refuse before it starts anything, so a context that throws on any use proves it.
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('a role was started');
    },
  },
) as RoleContext;

describe('startRoles', () => {
  it('fails fast on a role that is not implemented yet, naming its milestone', async () => {
    const start = startRoles(['sweeper', 'relay', 'listing', 'dashboard'], untouchable);
    await expect(start).rejects.toThrow(RoleNotImplementedError);
    await expect(start).rejects.toThrow(
      'WORKER_ROLES enables roles that are not implemented yet: listing (until M8), dashboard (until M7).',
    );
  });
});
