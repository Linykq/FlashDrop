import type { Scenario } from '../harness';
import { consumerKill } from './consumer-kill';
import { dupDelivery } from './dup-delivery';
import { pspOutage } from './psp-outage';
import { redisLostTail } from './redis-lost-tail';
import { redisRestart } from './redis-restart';
import { relayKill } from './relay-kill';

/** In `chaos:all` order: the core cases of design §13 first, then the stretch ones (§16 cut-line). */
export const SCENARIOS: readonly Scenario[] = [
  redisRestart,
  redisLostTail,
  relayKill,
  consumerKill,
  pspOutage,
  dupDelivery,
];
