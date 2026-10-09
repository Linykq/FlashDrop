import { createDb, createPool, OUTBOX_CHANNEL, POOL_PROFILES } from '@flashdrop/db';
import { createRelay, outboxRelayStore, type Publisher, type RelayHealth } from '@flashdrop/messaging';
import type { WorkerDeps } from '../deps';
import { listen } from '../listen';

/*
 * The `relay` role (design §5.4): publishes the outbox to Kafka. It polls every 250 ms and at once on
 * `NOTIFY outbox`, which only the low-rate paths send (checkout submit, expiry batches), so a
 * placed order reaches the payment consumer without waiting for the poll while the burst's reserves add no
 * second commit-time serialization point.
 *
 * Its pool carries the relay's session limits (`idle_in_transaction_session_timeout=30s`,
 * `transaction_timeout=20s`): every send settles within the producer's 10 s message timeout, so a batch
 * whose send fails rolls back with nothing in flight, and a relay that hangs mid-batch loses its session,
 * its rows and the publisher lock to a standby. Notifications only make a batch happen sooner: one lost
 * while the LISTEN connection was down is covered by the poll, and the relay polls at once on reconnect.
 */

export interface RelayRoleOptions {
  /** The relay's own pool and its LISTEN connection. */
  readonly databaseUrl: string;
  readonly publisher: Publisher;
}

export interface RelayRole {
  health(): RelayHealth;
  stop(): Promise<void>;
}

/** Two connections: the batch transaction, and the hourly cleanup that runs beside it. */
const RELAY_POOL_MAX = 2;

export function startRelay(deps: Pick<WorkerDeps, 'logger'>, options: RelayRoleOptions): RelayRole {
  const logger = deps.logger.child({ role: 'relay' });
  const pool = createPool({
    connectionString: options.databaseUrl,
    logger,
    ...POOL_PROFILES.relay,
    applicationName: 'worker:relay',
    max: RELAY_POOL_MAX,
  });
  const relay = createRelay({
    store: outboxRelayStore(createDb(pool)),
    publisher: options.publisher,
    logger,
  });
  const listener = listen({
    connectionString: options.databaseUrl,
    channel: OUTBOX_CHANNEL,
    applicationName: 'worker:relay:listen',
    logger,
    onNotify: () => relay.wake(),
    onListen: () => relay.wake(),
  });
  relay.start();
  return {
    health: () => relay.health(),
    async stop() {
      await listener.close();
      // The batch in flight commits or rolls back as usual before the pool closes under it.
      await relay.stop();
      await pool.end();
    },
  };
}
