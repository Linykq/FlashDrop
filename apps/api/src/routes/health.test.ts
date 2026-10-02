import { HealthResponse } from '@flashdrop/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { Api } from '../http/api';
import { buildTestApp, fakeServices, fakeState } from '../test/fakes';

let app: Api | undefined;
afterEach(() => app?.close());

async function withChecks(checks: Record<string, () => Promise<void>>): Promise<Api> {
  app = await buildTestApp({ services: { ...fakeServices(fakeState()), checks } });
  return app;
}

describe('GET /api/v1/health', () => {
  it('answers 200 when every dependency answers', async () => {
    const api = await withChecks({ postgres: async () => undefined });
    const response = await api.inject({ url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(HealthResponse.parse(response.json())).toEqual({ status: 'ok', checks: { postgres: 'ok' } });
  });

  it('answers 503 RETRY naming the dependency that failed', async () => {
    const api = await withChecks({
      postgres: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      other: async () => undefined,
    });
    const response = await api.inject({ url: '/api/v1/health' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toMatchObject({ code: 'RETRY', detail: 'postgres unavailable' });
  });
});

describe('GET /api/v1/health/live', () => {
  it('answers 200 without checking dependencies', async () => {
    const api = await withChecks({
      postgres: async () => {
        throw new Error('down');
      },
    });
    const response = await api.inject({ url: '/api/v1/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: {} });
  });
});
