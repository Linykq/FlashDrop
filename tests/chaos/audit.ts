import { z } from 'zod';

/*
 * The restart audit of a chaos run, on `docker inspect` output: no container restarted by Docker on its own,
 * and every service running and healthy at the end. Pure, so its rules have unit tests (./audit.test.ts).
 */

export interface ContainerState {
  /** The short id, which is also the container's hostname. */
  readonly id: string;
  readonly name: string;
  readonly service: string;
  /** Restarts by Docker's restart policy since the container was created: a process that exited by itself. */
  readonly restarts: number;
  /** `unless-stopped` for the application services; `no` for the data stores and the one-shot jobs. */
  readonly restartPolicy: string;
  readonly running: boolean;
  /** `healthy`, `starting`, `unhealthy`, or '' without a healthcheck. */
  readonly health: string;
  readonly exitCode: number;
  /** When its process last started (the Docker VM's clock, like the services' log times). */
  readonly startedAt: string;
  /** When its process last exited; kept while it runs again. */
  readonly finishedAt: string;
}

const Inspected = z
  .object({
    Id: z.string().min(12),
    Name: z.string(),
    RestartCount: z.int(),
    Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
    HostConfig: z.object({ RestartPolicy: z.object({ Name: z.string() }) }),
    State: z.object({
      Running: z.boolean(),
      ExitCode: z.int(),
      Health: z.object({ Status: z.string() }).optional(),
      StartedAt: z.string(),
      FinishedAt: z.string(),
    }),
  })
  .transform(
    (c): ContainerState => ({
      id: c.Id.slice(0, 12),
      name: c.Name.replace(/^\//, ''),
      service: c.Config.Labels?.['com.docker.compose.service'] ?? '',
      restarts: c.RestartCount,
      restartPolicy: c.HostConfig.RestartPolicy.Name,
      running: c.State.Running,
      health: c.State.Health?.Status ?? '',
      exitCode: c.State.ExitCode,
      startedAt: c.State.StartedAt,
      finishedAt: c.State.FinishedAt,
    }),
  );

/** `docker inspect <id>...` output: a JSON array, one object per container. */
export function parseInspect(json: string): ContainerState[] {
  return z.array(Inspected).parse(JSON.parse(json));
}

/**
 * Restarts Docker made on its own since `baseline`: a process that crashed or exited during the run and was
 * brought back by `restart: unless-stopped`, which would otherwise pass unnoticed (tools/check-restarts.sh,
 * per container instead of per stack). A container created during the run counts from 0. The faults a run
 * injects (kill, stop, pause) are manual, and Docker never restarts those, so they never count.
 */
export function restartsSince(baseline: readonly ContainerState[], now: readonly ContainerState[]): string[] {
  const before = new Map(baseline.map((c) => [c.id, c.restarts]));
  return now
    .filter((c) => c.restarts > (before.get(c.id) ?? 0))
    .map((c) => `${c.name} restarted by Docker ${c.restarts - (before.get(c.id) ?? 0)} time(s)`);
}

/**
 * Containers that are neither running and healthy nor a one-shot job that completed (migrate, kafka-init:
 * no restart policy, exit code 0).
 */
export function notHealthy(now: readonly ContainerState[]): string[] {
  return now.flatMap((c) => {
    if (!c.running) {
      const completedJob = c.restartPolicy === 'no' && c.exitCode === 0;
      return completedJob ? [] : [`${c.name} is not running (exit code ${c.exitCode})`];
    }
    if (c.health !== '' && c.health !== 'healthy') return [`${c.name} is ${c.health}`];
    return [];
  });
}
