import { Counter, Registry } from '@prometheus-io/client';
import { describe, expect, it } from 'vitest';
import { type ComponentHealth, healthReport, startHealthServer } from './health';

const quiet = { info: () => undefined, error: () => undefined };

const component = (name: string, healthy: boolean): ComponentHealth => ({
  name,
  healthy,
  lastOkAt: healthy ? '2026-10-02T12:00:00.000Z' : null,
  consecutiveFailures: healthy ? 0 : 3,
  lastError: healthy ? null : 'connection refused',
});

describe('healthReport', () => {
  it('is ok only when every component is healthy', () => {
    const roles = ['sweeper'] as const;
    expect(
      healthReport({ roles, components: () => [component('a', true), component('b', true)] }).status,
    ).toBe('ok');
    expect(
      healthReport({ roles, components: () => [component('a', true), component('b', false)] }).status,
    ).toBe('unhealthy');
    // Before the roles have started there is nothing to vouch for the process yet.
    expect(healthReport({ roles, components: () => [] }).status).toBe('unhealthy');
  });
});

describe('startHealthServer', () => {
  it('answers GET /health with 200 or 503 and the report, and 404 elsewhere', async () => {
    let healthy = true;
    const server = await startHealthServer({
      host: '127.0.0.1',
      port: 0,
      source: { roles: ['reconciler'], components: () => [component('reconciler', healthy)] },
      logger: quiet,
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const ok = await fetch(`${url}/health`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('no-store');
      expect(await ok.json()).toMatchObject({ status: 'ok', roles: ['reconciler'] });

      healthy = false;
      const failing = await fetch(`${url}/health`);
      expect(failing.status).toBe(503);
      expect(await failing.json()).toMatchObject({
        status: 'unhealthy',
        components: [{ name: 'reconciler', lastError: 'connection refused' }],
      });

      expect((await fetch(`${url}/metrics`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('serves GET /metrics in the Prometheus text format when given a registry', async () => {
    const registry = new Registry();
    new Counter({ name: 'fd_test_total', help: 'A test series.', registers: [registry] }).inc(2);
    const server = await startHealthServer({
      host: '127.0.0.1',
      port: 0,
      source: { roles: ['relay'], components: () => [component('relay', true)] },
      metrics: registry,
      logger: quiet,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(registry.contentType);
      expect(await response.text()).toContain('fd_test_total 2');
    } finally {
      await server.close();
    }
  });
});
