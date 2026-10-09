import { revalidateTag } from 'next/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

const SECRET = 'r'.repeat(40);

function post(body: unknown, secret: string | null = SECRET): Promise<Response> {
  return POST(
    new Request('http://web:3000/_internal/revalidate', {
      method: 'POST',
      headers: secret === null ? {} : { 'x-revalidate-secret': secret },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv('REVALIDATE_SECRET', SECRET);
  vi.stubEnv('LOG_LEVEL', 'silent');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(revalidateTag).mockClear();
});

describe('POST /_internal/revalidate', () => {
  it('revalidates a tag stale-while-revalidate', async () => {
    const response = await post({ tag: 'drops' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revalidated: 'drops' });
    expect(revalidateTag).toHaveBeenCalledWith('drops', 'max');

    await post({ tag: 'product:5eed0003-0000-4000-8000-000000000002' });
    expect(revalidateTag).toHaveBeenLastCalledWith('product:5eed0003-0000-4000-8000-000000000002', 'max');
  });

  it.each([
    ['no secret', null],
    ['an empty secret', ''],
    ['a wrong secret of the same length', 'x'.repeat(40)],
    ['a wrong secret of another length', 'short'],
  ])('answers 401 to %s', async (_name, secret) => {
    expect((await post({ tag: 'drops' }, secret)).status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', 'drops'],
    ['an empty tag', { tag: '' }],
    ['a tag web never caches under', { tag: '../drops' }],
    ['a missing tag', {}],
  ])('answers 400 to %s', async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
