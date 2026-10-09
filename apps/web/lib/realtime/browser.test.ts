import { describe, expect, it } from 'vitest';
import { gatewayUrl, pinnedPath } from './browser';

describe('gatewayUrl', () => {
  it('is the page origin, with the scheme of the page', () => {
    expect(gatewayUrl({ protocol: 'http:', host: '127.0.0.1:8080' }, '/ws')).toBe('ws://127.0.0.1:8080/ws');
    expect(gatewayUrl({ protocol: 'https:', host: 'shop.example.com' }, '/ws/2')).toBe(
      'wss://shop.example.com/ws/2',
    );
  });
});

describe('pinnedPath', () => {
  it('pins the first socket to one instance with ?ws=N', () => {
    expect(pinnedPath('?ws=1')).toBe('/ws/1');
    expect(pinnedPath('?ref=nav&ws=2')).toBe('/ws/2');
  });

  it.each(['', '?ws=', '?ws=0', '?ws=../admin', '?ws=1%2F..', '?ws=123'])('ignores %j', (search) => {
    expect(pinnedPath(search)).toBeNull();
  });
});
