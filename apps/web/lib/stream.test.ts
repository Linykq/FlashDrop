import { describe, expect, it } from 'vitest';
import { isBehindLive, livePosition, streamAssets, streamState } from './stream';

describe('streamAssets', () => {
  it('finds the poster and captions beside the playlist', () => {
    expect(streamAssets('/hls/live.m3u8')).toEqual({
      src: '/hls/live.m3u8',
      poster: '/hls/poster.jpg',
      captions: '/hls/captions.en.vtt',
    });
    expect(streamAssets('https://cdn.example.com/a/b.m3u8').poster).toBe(
      'https://cdn.example.com/a/poster.jpg',
    );
  });
});

describe('streamState', () => {
  it('is on air while the pinned drop is open, and says when it is not', () => {
    expect(streamState('LIVE')).toBe('live');
    expect(streamState('PAUSED')).toBe('live');
    expect(streamState('SCHEDULED')).toBe('upcoming');
    expect(streamState(null)).toBe('upcoming');
    expect(streamState('ENDED')).toBe('ended');
  });
});

describe('live position', () => {
  it('puts every viewer at the same second of the loop', () => {
    expect(livePosition(1_000 * 48 * 10 + 12_500, 48)).toBeCloseTo(12.5);
    expect(livePosition(5_000, 0)).toBe(0);
  });

  it('counts a viewer behind only past the tolerance, across the wrap too', () => {
    expect(isBehindLive(10, 12, 48)).toBe(false);
    expect(isBehindLive(10, 20, 48)).toBe(true);
    expect(isBehindLive(46, 2, 48)).toBe(false);
    expect(isBehindLive(40, 2, 48)).toBe(true);
    // Slightly ahead of the live point: noise, not behind.
    expect(isBehindLive(13, 12, 48)).toBe(false);
    expect(isBehindLive(10, 30, Number.NaN)).toBe(false);
  });
});
