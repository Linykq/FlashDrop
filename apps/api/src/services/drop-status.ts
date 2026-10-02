import { BugError, type DropStatus, type PublicDropStatus } from '@flashdrop/domain';

/**
 * Narrows a drop status that a query already filtered to the public ones. A DRAFT here means the filter
 * was lost, which must fail rather than show an unarmed drop to buyers.
 */
export function publicDropStatus(status: DropStatus): PublicDropStatus {
  if (status === 'DRAFT') throw new BugError('a DRAFT drop reached a public read');
  return status;
}
