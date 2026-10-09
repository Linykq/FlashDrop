import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compose, type LogLine, logLines } from '../../tools/system/support';
import { type ContainerState, parseInspect } from './audit';

export type { ContainerState, LogLine };

/*
 * What a chaos run asks Docker about the stack: each container's state (for the restart audit, ./audit.ts),
 * and the logs that show what a service did about a fault.
 */

const exec = promisify(execFile);

export async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await exec('docker', [...args], { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

/** Every container of the stack, running or not, of every service the `app` profile starts. */
export async function containers(): Promise<ContainerState[]> {
  const ids = (await compose(['ps', '--all', '--quiet'])).split(/\s+/).filter(Boolean);
  if (ids.length === 0) throw new Error('the stack has no containers: is it up?');
  return parseInspect(await docker(['inspect', ...ids]));
}

/** The containers of one service, e.g. the two `consumers` replicas. */
export async function containersOf(service: string): Promise<ContainerState[]> {
  return (await containers()).filter((c) => c.service === service);
}

/** `docker compose unpause`, which fails on a container that is not paused, only where one is. */
export async function unpauseIfPaused(service: string): Promise<void> {
  const ids = (await compose(['ps', '--quiet', service])).split(/\s+/).filter(Boolean);
  if (ids.length === 0) return;
  const paused = await docker(['inspect', '--format', '{{.State.Paused}}', ...ids]);
  if (paused.includes('true')) await compose(['unpause', service]);
}

/** A container's pino lines since `since`. */
export async function logsSince(containerId: string, since: Date): Promise<LogLine[]> {
  return logLines(await docker(['logs', '--since', since.toISOString(), containerId]));
}
