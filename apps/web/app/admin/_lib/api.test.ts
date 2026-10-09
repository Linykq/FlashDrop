import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { adminWrite } from './api';

const request = vi.hoisted(() => ({ headers: new Headers(), cookie: 'token' as string | null }));

vi.mock('next/headers', () => ({
  headers: async () => request.headers,
  cookies: async () => ({
    get: () => (request.cookie === null ? undefined : { value: request.cookie }),
  }),
}));

function stubApi() {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** The Origin header of the one request api received. */
function sentOrigin(fetch: ReturnType<typeof stubApi>): unknown {
  const init = fetch.mock.calls[0]?.at(1);
  return typeof init === 'object' && init !== null
    ? Reflect.get(Reflect.get(init, 'headers'), 'origin')
    : null;
}

beforeEach(() => {
  vi.stubEnv('LOG_LEVEL', 'silent');
  request.cookie = 'token';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('adminWrite', () => {
  it("forwards the browser's own Origin to api's CSRF guard, not one built from the Host", async () => {
    request.headers = new Headers({
      origin: 'http://127.0.0.1:8080',
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
    });
    const fetch = stubApi();
    const result = await adminWrite('POST', '/api/v1/admin/drops/x/pause', undefined, z.object({}));
    expect(result.ok).toBe(true);
    expect(sentOrigin(fetch)).toBe('http://127.0.0.1:8080');
  });

  it('passes a foreign Origin through unchanged, for api to refuse', async () => {
    request.headers = new Headers({ origin: 'https://evil.example', host: '127.0.0.1:8080' });
    const fetch = stubApi();
    await adminWrite('POST', '/api/v1/admin/drops/x/pause', undefined, z.object({}));
    expect(sentOrigin(fetch)).toBe('https://evil.example');
  });

  it('refuses a write that arrived without an Origin, without calling api', async () => {
    request.headers = new Headers({ host: '127.0.0.1:8080' });
    const fetch = stubApi();
    const result = await adminWrite('POST', '/api/v1/admin/drops/x/pause', undefined, z.object({}));
    expect(result).toEqual({ ok: false, status: 403, problem: undefined });
    expect(fetch).not.toHaveBeenCalled();
  });
});
