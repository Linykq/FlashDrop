import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Browser, Page } from '@playwright/test';
import { expect, reserveViaApi, signInNewBuyer, stockOf, test } from './support/fixtures';
import {
  type GatewayRecording,
  type GatewaySocket,
  instanceIds,
  recordGateway,
  stockFrames,
  strictlyNewer,
} from './support/realtime';
import { stockLinePattern } from './support/text';

/*
 * Gateway failover (design §7, §16 M5 demo: `docker kill api-1`, clients reconnect and resync), with real
 * browsers through Caddy. Two pages are pinned to api-1 through /ws/1; api-1 is killed with SIGKILL, as a
 * crash ends it. Each page's socket closes, and its reconnect goes through /ws (only a tab's first socket is
 * pinned), which Caddy fails over to api-2: a socket on another instance, whose first stock frame is a
 * snapshot, so the page catches up on what it missed and then follows the stock live. api-1 comes back at
 * the end, healthy, and tools/check-restarts.sh still passes (a kill is a manual stop, never restarted).
 *
 * It kills an instance of the stack it runs on, so it runs only where the system tests may disrupt the stack
 * (FD_SYSTEM_TESTS=1: CI's system job, or compose.isolated.yaml): `FD_SYSTEM_TESTS=1 pnpm test:e2e ws-failover`.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const STOCK_POLLS = '**/api/v1/drops/*/stock';
/** The socket's close, a jittered backoff of at most 0.5 s, and Caddy trying api-1 (1 s dial timeout) first. */
const RECONNECTED_WITHIN_MS = 15_000;
/** Shown once the new socket has the level: a render, on a runner that also hosts the stack. */
const SHOWN_WITHIN_MS = 5_000;

const exec = promisify(execFile);

/** `docker compose --profile app <args>` from the repo root, with the job's COMPOSE_FILE. */
async function compose(...args: string[]): Promise<void> {
  await exec('docker', ['compose', '--profile', 'app', ...args], { cwd: REPO_ROOT, env: process.env });
}

interface Viewer {
  readonly page: Page;
  readonly gateway: GatewayRecording;
}

async function openViewer(browser: Browser, slug: string): Promise<Viewer> {
  const page = await (await browser.newContext()).newPage();
  const gateway = recordGateway(page);
  // The socket is then the only way a level can reach the page.
  await page.route(STOCK_POLLS, (route) => route.abort());
  await page.goto(`/p/${slug}?ws=1`);
  return { page, gateway };
}

const stockLine = (page: Page) => page.getByRole('main').getByText(/^(Only )?[\d,]+ left$/);

/** The `hello.instanceId` of one socket, once received. */
const instanceOf = (socket: GatewaySocket | undefined) => {
  const hello = socket?.frames.find((frame) => frame.message.type === 'hello')?.message;
  return hello?.type === 'hello' ? hello.instanceId : undefined;
};

/**
 * The newest socket after the first that an instance greeted, or -1. An attempt Caddy could not upgrade
 * (it tried the dead instance) is a socket too, closed without a hello.
 */
const reconnectedIndex = ({ sockets }: GatewayRecording) =>
  sockets.findLastIndex((socket, index) => index > 0 && instanceOf(socket) !== undefined);

test.skip(
  process.env.FD_SYSTEM_TESTS !== '1',
  'kills api-1: runs only with FD_SYSTEM_TESTS=1, on a stack nobody else is using (CI system job)',
);
test.use({ dropSettings: { stock: 20, perUserLimit: 5 } });

test('docker kill api-1: pinned pages reconnect through /ws to api-2, resync from a snapshot and stay live', async ({
  browser,
  drop,
  request,
  baseURL,
}) => {
  const viewers = [await openViewer(browser, drop.productSlug), await openViewer(browser, drop.productSlug)];
  const buyer = await browser.newContext();
  try {
    await signInNewBuyer(request, baseURL, buyer);
    for (const { page, gateway } of viewers) {
      await expect(stockLine(page)).toHaveText(stockLinePattern(20));
      await expect.poll(() => stockFrames(gateway, drop.id).map((frame) => frame.type)).toEqual(['snapshot']);
    }
    const killed = instanceOf(viewers[0]?.gateway.sockets[0]);
    expect(killed).toBeDefined();
    for (const { gateway } of viewers) {
      expect(gateway.sockets.map((socket) => socket.path)).toEqual(['/ws/1']);
      expect(instanceIds(gateway)).toEqual([killed]);
    }

    await compose('kill', '--signal', 'SIGKILL', 'api-1');
    // While the pages reconnect: through Caddy, which fails /api over to api-2 as well.
    await reserveViaApi(buyer.request, baseURL, drop.id, 3);

    for (const { gateway } of viewers) {
      await expect
        .poll(() => reconnectedIndex(gateway), {
          message: 'a new socket is greeted by an instance',
          timeout: RECONNECTED_WITHIN_MS,
        })
        .toBeGreaterThan(0);
      const index = reconnectedIndex(gateway);
      const reconnected = gateway.sockets[index];
      expect(gateway.sockets[0]?.closed).toBe(true);
      expect(instanceOf(reconnected)).not.toBe(killed);
      // Only the first socket is pinned: /ws/1 would lead back to the dead instance.
      expect(reconnected?.path).toBe('/ws');
      // Resync: the new socket starts from a snapshot of the level, not from where the old one stopped.
      await expect
        .poll(() => stockFrames(gateway, drop.id).find((frame) => frame.socket === index)?.type, {
          timeout: SHOWN_WITHIN_MS,
        })
        .toBe('snapshot');
    }
    let truth = await stockOf(request, drop.id);
    expect(truth).toMatchObject({ avail: 17, held: 3 });
    for (const { page } of viewers) {
      await expect(stockLine(page)).toHaveText(stockLinePattern(truth.avail), { timeout: SHOWN_WITHIN_MS });
    }

    // Live on the new instance: the next change arrives as a delta on the new socket.
    await reserveViaApi(buyer.request, baseURL, drop.id, 2);
    truth = await stockOf(request, drop.id);
    expect(truth).toMatchObject({ avail: 15, held: 5 });
    for (const { page, gateway } of viewers) {
      await expect(stockLine(page)).toHaveText(stockLinePattern(15), { timeout: SHOWN_WITHIN_MS });
      const frames = stockFrames(gateway, drop.id);
      const onNewSocket = frames.filter((frame) => frame.socket === reconnectedIndex(gateway));
      expect(onNewSocket.at(-1)).toMatchObject({
        type: 'delta',
        data: { avail: truth.avail, held: truth.held, sold: truth.sold },
      });
      expect(strictlyNewer(onNewSocket)).toBe(true);
      expect(gateway.malformed).toEqual([]);
    }
  } finally {
    await buyer.close();
    await Promise.all(viewers.map(({ page }) => page.context().close()));
    // The same container, started again; never re-created (it would no longer be the stack under test).
    await compose('up', '--detach', '--wait', '--wait-timeout', '180', '--no-deps', '--no-recreate', 'api-1');
  }
});
