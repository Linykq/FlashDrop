import type { WebSocket } from '@playwright/test';
import { expect, test } from './support/fixtures';

/*
 * The gateway fixes a socket's principal at the upgrade, from the session cookie (design §7, §11), and
 * signing in or out is a client navigation that keeps the tab's one socket. So the tab replaces its socket
 * when the session changes: otherwise a buyer who signed in mid-visit would never get the `order` pushes,
 * and a tab where another account signed in would keep the last one's `user` channel and admin rights.
 */

test('signing in from a live page replaces the tab’s socket with one opened under the new session', async ({
  page,
  drop,
}) => {
  const sockets: WebSocket[] = [];
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.startsWith('/ws')) sockets.push(socket);
  });
  await page.goto(`/p/${drop.productSlug}`);
  await expect.poll(() => sockets.length, { message: 'the product page opens a socket' }).toBe(1);
  const before = sockets[0];
  if (before === undefined) throw new Error('no socket');
  const closed = new Promise<void>((resolve) => before.on('close', () => resolve()));

  // Signed out, Buy leads to the sign-in page; Continue signs in as the first seeded account and returns,
  // all without a reload.
  await page.getByRole('main').getByRole('link', { name: 'Sign in to buy' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${drop.productSlug}$`));
  await expect(page.getByRole('main').getByRole('button', { name: /^Buy/ })).toBeVisible();

  await closed;
  await expect
    .poll(() => sockets.length, { message: 'a socket opened under the new session replaces the old one' })
    .toBe(2);
  expect(sockets[1]?.isClosed()).toBe(false);
});
