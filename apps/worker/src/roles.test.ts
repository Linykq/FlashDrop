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
  it('fails fast on a role that is not implemented yet, naming its milestone', () => {
    expect(() => startRoles(['sweeper', 'relay', 'listing'], untouchable)).toThrow(RoleNotImplementedError);
    expect(() => startRoles(['sweeper', 'relay', 'listing'], untouchable)).toThrow(
      'WORKER_ROLES enables roles that are not implemented yet: relay (until M3), listing (until M8).',
    );
  });

  it.each([
    ['settlement', 'M3'],
    ['payment', 'M4'],
    ['dashboard', 'M7'],
  ] as const)('names %s as coming in %s', (role, milestone) => {
    expect(() => startRoles([role], untouchable)).toThrow(`${role} (until ${milestone})`);
  });
});
