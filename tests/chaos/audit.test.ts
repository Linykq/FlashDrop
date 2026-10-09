import { describe, expect, it } from 'vitest';
import { type ContainerState, notHealthy, parseInspect, restartsSince } from './audit';

/** One container as `docker inspect` prints it, trimmed to what the audit reads. */
function inspected(over: {
  id: string;
  name: string;
  restarts?: number;
  policy?: string;
  running?: boolean;
  exitCode?: number;
  health?: string;
}) {
  return {
    Id: over.id.padEnd(64, '0'),
    Name: `/${over.name}`,
    RestartCount: over.restarts ?? 0,
    Config: { Labels: { 'com.docker.compose.service': over.name.replace(/^flashdrop-sys-|-\d+$/g, '') } },
    HostConfig: { RestartPolicy: { Name: over.policy ?? 'unless-stopped' } },
    State: {
      Running: over.running ?? true,
      ExitCode: over.exitCode ?? 0,
      ...(over.health === undefined ? {} : { Health: { Status: over.health } }),
      StartedAt: '2026-10-09T15:00:00.000000000Z',
      FinishedAt: '0001-01-01T00:00:00Z',
    },
  };
}

const parse = (...containers: ReturnType<typeof inspected>[]): ContainerState[] =>
  parseInspect(JSON.stringify(containers));

describe('parseInspect', () => {
  it('reads the short id, the service, the restart count and the health', () => {
    const [worker, migrate] = parse(
      inspected({ id: 'aaaaaaaaaaaa', name: 'flashdrop-sys-worker-1', restarts: 2, health: 'healthy' }),
      inspected({ id: 'bbbbbbbbbbbb', name: 'flashdrop-sys-migrate-1', policy: 'no', running: false }),
    );
    expect(worker).toMatchObject({ id: 'aaaaaaaaaaaa', service: 'worker', restarts: 2, health: 'healthy' });
    expect(migrate).toMatchObject({ service: 'migrate', restartPolicy: 'no', running: false, health: '' });
  });
});

describe('restartsSince', () => {
  it('counts only restarts Docker made after the baseline, and a new container from 0', () => {
    const baseline = parse(
      inspected({ id: 'aaaaaaaaaaaa', name: 'flashdrop-sys-worker-1', restarts: 1 }),
      inspected({ id: 'bbbbbbbbbbbb', name: 'flashdrop-sys-api-1-1' }),
    );
    const now = parse(
      // Restarted once before the run: not this run's crash.
      inspected({ id: 'aaaaaaaaaaaa', name: 'flashdrop-sys-worker-1', restarts: 1 }),
      inspected({ id: 'bbbbbbbbbbbb', name: 'flashdrop-sys-api-1-1', restarts: 2 }),
      // Re-created by the run (payment-mock), then crashed and was brought back.
      inspected({ id: 'cccccccccccc', name: 'flashdrop-sys-payment-mock-1', restarts: 1 }),
    );
    expect(restartsSince(baseline, now)).toEqual([
      'flashdrop-sys-api-1-1 restarted by Docker 2 time(s)',
      'flashdrop-sys-payment-mock-1 restarted by Docker 1 time(s)',
    ]);
    expect(restartsSince(now, now)).toEqual([]);
  });
});

describe('notHealthy', () => {
  it('accepts running healthy services and completed one-shot jobs', () => {
    const states = parse(
      inspected({ id: 'aaaaaaaaaaaa', name: 'flashdrop-sys-api-1-1', health: 'healthy' }),
      inspected({ id: 'bbbbbbbbbbbb', name: 'flashdrop-sys-redis-1', policy: 'no' }),
      inspected({ id: 'cccccccccccc', name: 'flashdrop-sys-kafka-init-1', policy: 'no', running: false }),
    );
    expect(notHealthy(states)).toEqual([]);
  });

  it('reports a stopped service, a failed job and an unhealthy one', () => {
    const states = parse(
      inspected({ id: 'aaaaaaaaaaaa', name: 'flashdrop-sys-worker-1', running: false, exitCode: 137 }),
      inspected({
        id: 'bbbbbbbbbbbb',
        name: 'flashdrop-sys-redis-1',
        policy: 'no',
        running: false,
        exitCode: 137,
      }),
      inspected({
        id: 'cccccccccccc',
        name: 'flashdrop-sys-migrate-1',
        policy: 'no',
        running: false,
        exitCode: 1,
      }),
      inspected({ id: 'dddddddddddd', name: 'flashdrop-sys-consumers-1', health: 'unhealthy' }),
    );
    expect(notHealthy(states)).toEqual([
      'flashdrop-sys-worker-1 is not running (exit code 137)',
      'flashdrop-sys-redis-1 is not running (exit code 137)',
      'flashdrop-sys-migrate-1 is not running (exit code 1)',
      'flashdrop-sys-consumers-1 is unhealthy',
    ]);
  });
});
