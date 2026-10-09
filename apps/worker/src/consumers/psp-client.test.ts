import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BugError } from '@flashdrop/domain';
import { classifyFailure } from '@flashdrop/messaging';
import { afterEach, describe, expect, it } from 'vitest';
import { registry } from '../metrics';
import { createPspClient, PspUnavailableError } from './psp-client';

/*
 * How the PSP client turns answers into outcomes (design §6.4, §6.5): a timeout or 5xx is an unknown
 * outcome the runner retries with the same key, forever; a 4xx or a broken contract is a bug.
 */

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

interface Received {
  readonly authorization: string | undefined;
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly key: string | string[] | undefined;
  readonly body: string;
}

/** A PSP that answers every request with `answer`, recording what it received. */
async function psp(
  answer: (response: ServerResponse) => void,
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    received.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
      key: request.headers['idempotency-key'],
      body,
    });
    answer(response);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${address.port}`, received };
}

const json = (status: number, body: unknown) => (response: ServerResponse) =>
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const request = {
  reference: '0b5b7c6e-6f0c-4a63-9d43-1f3f0e2f6a11',
  amountCents: 1_999,
  paymentMethod: 'pm_ok',
} as const;

const transient = (error: unknown) => classifyFailure(error, () => false);

const API_KEY = 'test-psp-api-key-at-least-32-chars';
const client = (baseUrl: string, timeoutMs?: number) =>
  createPspClient({ baseUrl, apiKey: API_KEY, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

describe('createPspClient', () => {
  it('sends the charge with its Idempotency-Key and parses the answer', async () => {
    const { url, received } = await psp(json(200, { status: 'succeeded', id: 'ch_1' }));
    const pspClient = client(url);

    await expect(pspClient.charge(request, `charge:${request.reference}`)).resolves.toEqual({
      status: 'succeeded',
      id: 'ch_1',
    });
    expect(received).toEqual([
      {
        authorization: `Bearer ${API_KEY}`,
        method: 'POST',
        url: '/v1/charges',
        key: `charge:${request.reference}`,
        body: JSON.stringify(request),
      },
    ]);
  });

  it('closes a reference without a body', async () => {
    const { url, received } = await psp(json(200, { refundedChargeId: 'ch_1', amountCents: 1_999 }));
    const pspClient = client(url);

    await expect(pspClient.closeReference(request.reference, `close:${request.reference}`)).resolves.toEqual({
      refundedChargeId: 'ch_1',
      amountCents: 1_999,
    });
    expect(received[0]).toMatchObject({ url: `/v1/references/${request.reference}/close`, body: '' });
  });

  it('reads past fields the contract does not know: a PSP adding one must not fail every charge and close', async () => {
    const { url } = await psp(json(200, { status: 'succeeded', id: 'ch_1', livemode: false }));
    const pspClient = client(url);
    await expect(pspClient.charge(request, 'k')).resolves.toEqual({ status: 'succeeded', id: 'ch_1' });

    const closed = await psp(json(200, { refundedChargeId: 'ch_1', amountCents: 1_999, refundId: 're_1' }));
    await expect(client(closed.url).closeReference(request.reference, 'k')).resolves.toEqual({
      refundedChargeId: 'ch_1',
      amountCents: 1_999,
    });
  });

  it.each([500, 503, 408, 429])('takes %i as an unknown outcome to retry', async (status) => {
    const { url } = await psp(json(status, { error: { code: 'unavailable', message: 'busy' } }));
    const error = await client(url)
      .charge(request, 'k')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PspUnavailableError);
    expect(transient(error)).toBe('transient');
  });

  it('takes no answer within the timeout as an unknown outcome to retry', async () => {
    const { url } = await psp(() => undefined); // never answers
    const error = await client(url, 100)
      .charge(request, 'k')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PspUnavailableError);
    expect(transient(error)).toBe('transient');
  });

  it('takes a refused connection as an unknown outcome to retry', async () => {
    const error = await client('http://127.0.0.1:9')
      .charge(request, 'k')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PspUnavailableError);
  });

  it.each([
    ['a 4xx', json(422, { error: { code: 'idempotency_key_reused', message: 'no' } })],
    ['a 200 outside the contract', json(200, { status: 'pending' })],
    ['a 200 that is not JSON', (response: ServerResponse) => response.writeHead(200).end('ok')],
  ])('takes %s as a bug, not as something to retry forever', async (_, answer) => {
    const { url } = await psp(answer);
    const error = await client(url)
      .charge(request, 'k')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BugError);
    expect(transient(error)).toBe('unclassified');
  });

  it('counts every call once, by operation and result (fd_psp_requests_total)', async () => {
    const counted = async (op: string, result: string) => {
      const metric = registry.getSingleMetric('fd_psp_requests_total');
      const values = (await metric?.get())?.values ?? [];
      return values.find((v) => v.labels.op === op && v.labels.result === result)?.value ?? 0;
    };
    const before = {
      declined: await counted('charge', 'declined'),
      timeout: await counted('charge', 'timeout'),
      unavailable: await counted('close', 'unavailable'),
      closed: await counted('close', 'closed'),
    };

    const declined = await psp(json(200, { status: 'declined', id: 'ch_2', declineCode: 'card_declined' }));
    await client(declined.url).charge(request, 'k');
    const silent = await psp(() => undefined);
    await client(silent.url, 50)
      .charge(request, 'k')
      .catch(() => undefined);
    const busy = await psp(json(503, { error: { code: 'unavailable', message: 'busy' } }));
    await client(busy.url)
      .closeReference(request.reference, 'k')
      .catch(() => undefined);
    const nothing = await psp(json(200, {}));
    await client(nothing.url).closeReference(request.reference, 'k');

    expect(await counted('charge', 'declined')).toBe(before.declined + 1);
    expect(await counted('charge', 'timeout')).toBe(before.timeout + 1);
    expect(await counted('close', 'unavailable')).toBe(before.unavailable + 1);
    expect(await counted('close', 'closed')).toBe(before.closed + 1);
  });
});
