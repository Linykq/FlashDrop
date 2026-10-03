import { readFileSync } from 'node:fs';
import { ErrorReply } from 'redis';
import { describe, expect, it, vi } from 'vitest';
import { HOLD_GRACE_MS } from './holds';
import {
  isFunctionNotFound,
  LIBRARY_VERSION,
  type LibraryHost,
  libraryState,
  libraryVersionOf,
  loadLibrary,
  withLibrary,
} from './library';
import { LIBRARY_SOURCE } from './library.generated';

const lua = readFileSync(new URL('../lua/flashdrop.lua', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

describe('the embedded library', () => {
  it('is lua/flashdrop.lua exactly (run `pnpm --filter @flashdrop/inventory embed-lua` after editing it)', () => {
    expect(LIBRARY_SOURCE).toBe(lua);
  });

  it('declares the library name, registers every Function and shares the hold grace with the sweeper', () => {
    expect(LIBRARY_SOURCE.startsWith('#!lua name=flashdrop\n-- version ')).toBe(true);
    const registered = [...LIBRARY_SOURCE.matchAll(/redis\.register_function\('(\w+)'/g)].map((m) => m[1]);
    expect(registered).toEqual([
      'fd_reserve',
      'fd_confirm',
      'fd_release',
      'fd_rebuild',
      'fd_set_status',
      'fd_rl_hit',
    ]);
    expect(LIBRARY_SOURCE).toContain(`local GRACE_MS = ${HOLD_GRACE_MS}\n`);
    // Functions registered with flags would change OOM and read-only behaviour (§4.2).
    expect(LIBRARY_SOURCE).not.toContain('flags');
  });
});

describe('loadLibrary', () => {
  /** A Redis holding `code` as the flashdrop library (none when undefined). */
  function holding(code: string | undefined) {
    const load = vi.fn(async () => undefined);
    const redis: LibraryHost = {
      functionLoad: load,
      functionListWithCode: async () =>
        code === undefined
          ? []
          : [{ library_name: 'flashdrop', engine: 'LUA', functions: [], library_code: code }],
    };
    return { redis, load };
  }
  const withVersion = (version: number) =>
    LIBRARY_SOURCE.replace(/^-- version \d+\./m, `-- version ${version}.`);

  it('reads the version under the shebang, and 0 for a library from before versioning', () => {
    expect(LIBRARY_VERSION).toBeGreaterThanOrEqual(1);
    expect(libraryVersionOf(withVersion(7))).toBe(7);
    expect(libraryVersionOf('#!lua name=flashdrop\nlocal x = 1\n')).toBe(0);
  });

  it('loads a missing or older library', async () => {
    for (const code of [undefined, withVersion(LIBRARY_VERSION - 1), '#!lua name=flashdrop\n']) {
      const { redis, load } = holding(code);
      expect(await libraryState(redis)).toBe(code === undefined ? 'MISSING' : 'OLDER');
      expect(await loadLibrary(redis)).toBe('LOADED');
      expect(load).toHaveBeenCalledWith(LIBRARY_SOURCE, { REPLACE: true });
    }
  });

  it('never downgrades a newer library, and leaves this exact one alone', async () => {
    const newer = holding(withVersion(LIBRARY_VERSION + 1));
    expect(await libraryState(newer.redis)).toBe('NEWER');
    expect(await loadLibrary(newer.redis)).toBe('NEWER_KEPT');
    expect(newer.load).not.toHaveBeenCalled();

    const same = holding(LIBRARY_SOURCE);
    expect(await libraryState(same.redis)).toBe('CURRENT');
    expect(await loadLibrary(same.redis)).toBe('UNCHANGED');
    expect(same.load).not.toHaveBeenCalled();
  });

  // Regression: a working tree edited without a version bump (`pnpm test:int` from it, every run) replaced
  // the stack's library, and the running containers executed Lua their image never shipped.
  it('keeps the same version with other code, unless the caller owns the Redis', async () => {
    const edited = holding(`${LIBRARY_SOURCE}-- edited\n`);
    expect(await libraryState(edited.redis)).toBe('CURRENT_DIFFERS');
    expect(await loadLibrary(edited.redis)).toBe('CURRENT_DIFFERS');
    expect(edited.load).not.toHaveBeenCalled();

    expect(await loadLibrary(edited.redis, { replaceSameVersion: true })).toBe('LOADED');
    expect(edited.load).toHaveBeenCalledWith(LIBRARY_SOURCE, { REPLACE: true });
  });

  it('never downgrades a newer library, even for a caller that owns the Redis', async () => {
    const newer = holding(withVersion(LIBRARY_VERSION + 1));
    expect(await loadLibrary(newer.redis, { replaceSameVersion: true })).toBe('NEWER_KEPT');
    expect(newer.load).not.toHaveBeenCalled();
  });
});

describe('withLibrary', () => {
  const notFound = () => new ErrorReply('ERR Function not found');

  function host() {
    let loaded = false;
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      loaded = true;
    });
    const redis: LibraryHost = { functionLoad: load, functionListWithCode: async () => [] };
    const call = vi.fn(async () => {
      if (!loaded) throw notFound();
      return 'OK';
    });
    return { redis, load, call };
  }

  it('reloads once and retries when Redis lost the library', async () => {
    const { redis, load, call } = host();

    await expect(withLibrary(redis, call)).resolves.toBe('OK');
    expect(load).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('shares one reload between concurrent calls', async () => {
    const { redis, load, call } = host();

    const results = await Promise.all(Array.from({ length: 50 }, () => withLibrary(redis, call)));

    expect(results).toEqual(Array(50).fill('OK'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('passes every other error through without reloading', async () => {
    const { redis, load } = host();
    const failure = new ErrorReply('ERR flashdrop: malformed rsv entry');

    await expect(withLibrary(redis, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(load).not.toHaveBeenCalled();
    expect(isFunctionNotFound(failure)).toBe(false);
    expect(isFunctionNotFound(notFound())).toBe(true);
    expect(isFunctionNotFound(new Error('ERR Function not found'))).toBe(false);
  });
});
