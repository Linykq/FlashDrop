import { CONSUMER_GROUPS, partitionOwners } from '../../../tools/system/chaos-support';
import { startServices, until } from '../../../tools/system/support';
import { type ContainerState, containersOf, docker, logsSince } from '../docker';
import type { ChaosContext, Scenario } from '../harness';

/*
 * `consumer-kill` (design §13 stretch chaos case, §6.4, §17 "consumer crash, rebalance or zombie"): the
 * `consumers` replica that owns the sale's partition in the payment group is SIGKILLed mid-burst, with
 * charges in flight. Its uncommitted messages are redelivered: until the broker's session timeout evicts the
 * dead member, its partitions wait; then the cooperative-sticky rebalance gives them to the surviving
 * replica, which resumes from the last committed offsets. Charges retried under the same `charge:<orderId>`
 * key, the orders CAS and the Lua state machine make the redelivered work a no-op, so every order is paid
 * once (INV-4). The killed replica is then started again and the groups rebalance a second time.
 */

const GROUPS = [CONSUMER_GROUPS.payment, CONSUMER_GROUPS.settlement] as const;

/** A member's client id is `worker:<hostname>`, and a replica's hostname is its container's short id. */
const ownedBy = (clientId: string | undefined, container: ContainerState) =>
  clientId?.endsWith(container.id) === true;

let killedAt = 0;
let victim: ContainerState | undefined;

async function ownersOfPartition(ctx: ChaosContext): Promise<(string | undefined)[]> {
  return Promise.all(
    GROUPS.map(async (group) => (await partitionOwners(ctx.stores, group)).get(ctx.partition)),
  );
}

export const consumerKill: Scenario = {
  name: 'consumer-kill',
  fault: "SIGKILL the consumers replica that owns the sale's partition mid-burst; rebalance to the survivor",
  load: { buyers: 1400, stock: 800, faultAt: 0.25 },
  async inject(ctx) {
    const replicas = await containersOf('consumers');
    if (replicas.length !== 2) throw new Error(`expected 2 consumers replicas, found ${replicas.length}`);
    const [paymentOwner, settlementOwner] = await until(
      "the sale's partition owned in both groups",
      () => ownersOfPartition(ctx),
      (owners) => owners.every((owner) => owner !== undefined),
      30_000,
    );
    victim = replicas.find((replica) => ownedBy(paymentOwner, replica));
    const survivor = replicas.find((replica) => replica !== victim);
    if (victim === undefined || survivor === undefined) {
      throw new Error(`no replica matches the payment group's owner ${paymentOwner}`);
    }
    await docker(['kill', '--signal', 'SIGKILL', victim.id]);
    killedAt = Date.now();
    ctx.log(
      `SIGKILL ${victim.name}, owner of partition ${ctx.partition} in the payment group` +
        `${ownedBy(settlementOwner, victim) ? ' and the settlement group' : ''}`,
    );

    await until(
      `${survivor.name} owning partition ${ctx.partition} in both groups`,
      () => ownersOfPartition(ctx),
      (owners) => owners.every((owner) => ownedBy(owner, survivor)),
      120_000,
    );
    const takeoverMs = Date.now() - killedAt;
    ctx.log(`rebalanced: ${survivor.name} took partition ${ctx.partition} over after ${takeoverMs / 1000} s`);

    await startServices('consumers');
    const rejoinedMs = Date.now() - killedAt;
    ctx.log(
      `${victim.name} started again and healthy (assigned a partition) ${rejoinedMs / 1000} s after the kill`,
    );
    ctx.record('consumerKill', {
      victim: victim.name,
      survivor: survivor.name,
      ownersBefore: { payment: paymentOwner, settlement: settlementOwner },
      takeoverMs,
      rejoinedMs,
    });
  },
  async verify(ctx) {
    if (victim === undefined) return ['the fault was never injected'];
    // The rebalances as the members saw them: the survivor's assignments after the kill, the victim's on rejoin.
    const assignments = [];
    for (const replica of await containersOf('consumers')) {
      for (const line of await logsSince(replica.id, new Date(killedAt))) {
        if (line.msg === 'partitions assigned' || line.msg === 'partitions revoked') {
          assignments.push({
            replica: replica.name,
            at: line.time,
            group: line.groupId,
            msg: line.msg,
            owned: line.owned,
          });
        }
      }
    }
    ctx.record('rebalances', assignments);
    return assignments.length === 0 ? ['no replica logged a rebalance after the kill'] : [];
  },
  restore: () => startServices('consumers'),
};
