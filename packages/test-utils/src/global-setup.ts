import { formatInfraProblems, loadInfraEnv, probeInfra } from './infra';

/**
 * Vitest global setup of the `integration` project: when the Compose infra is down, fail the run within
 * seconds with one message that says what to start, instead of letting every test time out on its own.
 */
export default async function setup(): Promise<void> {
  const problems = await probeInfra(loadInfraEnv());
  if (problems.length > 0) throw new Error(formatInfraProblems(problems));
}
