import { ErrorReply } from 'redis';
import { z } from 'zod';
import { LIBRARY_SOURCE } from './library.generated';

/*
 * Loading the `flashdrop` library (design §4.2). Every process loads it at startup and reloads it whenever
 * a call fails with "ERR Function not found" (after FUNCTION FLUSH, or on a fresh Redis); the reconciler
 * also checks it every 2 s (§4.7).
 *
 * Functions are global to a Redis, so every process of every release shares one copy. The library carries
 * a version (`-- version N.` under its shebang), and a loader replaces only a missing or older copy:
 *   - never a newer one: an older image restarting during a rolling deploy cannot downgrade the Functions
 *     under the processes of the newer release;
 *   - never this version with other code, unless the caller owns the Redis (`replaceSameVersion`, the
 *     integration tests' own Redis): two copies of one version mean an edit without a version bump, and
 *     the processes that loaded the first copy would otherwise run Lua their image never shipped.
 * An older copy is replaced by the next process that starts and by the reconciler's check. (A newer release
 * that loads between another loader's FUNCTION LIST and its FUNCTION LOAD can still be overwritten once; its
 * own reconciler restores it within 2 s.)
 */

export const LIBRARY_NAME = 'flashdrop';

const VERSION_LINE = /^-- version (\d+)\./m;

/** The version a library's source declares; 0 for a library from before versioning. */
export function libraryVersionOf(code: string): number {
  const match = VERSION_LINE.exec(code);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/** The version this process ships. */
export const LIBRARY_VERSION = libraryVersionOf(LIBRARY_SOURCE);

/** The client surface the loader needs; a `FlashdropRedis` has it. */
export interface LibraryHost {
  functionLoad(code: string, options: { REPLACE: boolean }): Promise<unknown>;
  functionListWithCode(options: { LIBRARYNAME: string }): Promise<unknown>;
}

const FunctionList = z.array(
  z.object({ library_name: z.string().nullable(), library_code: z.string() }).loose(),
);

/** What Redis holds compared with this process's library. */
export type LibraryState =
  /** No `flashdrop` library: FUNCTION FLUSH or a fresh Redis. */
  | 'MISSING'
  | 'OLDER'
  /** This exact library. */
  | 'CURRENT'
  /** This version with other code: a working tree edited without a version bump loaded it. */
  | 'CURRENT_DIFFERS'
  /** A newer release loaded it; this process must not replace it. */
  | 'NEWER';

async function loadedCode(redis: LibraryHost): Promise<string | undefined> {
  const libraries = FunctionList.parse(await redis.functionListWithCode({ LIBRARYNAME: LIBRARY_NAME }));
  return libraries.find((library) => library.library_name === LIBRARY_NAME)?.library_code;
}

function stateOf(code: string | undefined): LibraryState {
  if (code === undefined) return 'MISSING';
  const version = libraryVersionOf(code);
  if (version < LIBRARY_VERSION) return 'OLDER';
  if (version > LIBRARY_VERSION) return 'NEWER';
  return code === LIBRARY_SOURCE ? 'CURRENT' : 'CURRENT_DIFFERS';
}

export async function libraryState(redis: LibraryHost): Promise<LibraryState> {
  return stateOf(await loadedCode(redis));
}

export interface LoadLibraryOptions {
  /**
   * Also replace this version with other code. Only for a Redis the caller owns: the integration tests
   * set it on their own Redis, so a run from an edited tree tests its own Lua.
   */
  readonly replaceSameVersion?: boolean;
}

/**
 * FUNCTION LOAD REPLACE of a missing or older library. `NEWER_KEPT` and `CURRENT_DIFFERS` leave Redis as it
 * is; the caller warns about the second, which needs a version bump.
 */
export async function loadLibrary(
  redis: LibraryHost,
  options: LoadLibraryOptions = {},
): Promise<'LOADED' | 'UNCHANGED' | 'NEWER_KEPT' | 'CURRENT_DIFFERS'> {
  const state = await libraryState(redis);
  if (state === 'CURRENT') return 'UNCHANGED';
  if (state === 'NEWER') return 'NEWER_KEPT';
  if (state === 'CURRENT_DIFFERS' && options.replaceSameVersion !== true) return 'CURRENT_DIFFERS';
  await redis.functionLoad(LIBRARY_SOURCE, { REPLACE: true });
  return 'LOADED';
}

export function isFunctionNotFound(error: unknown): boolean {
  return error instanceof ErrorReply && error.message.startsWith('ERR Function not found');
}

const reloads = new WeakMap<LibraryHost, Promise<unknown>>();

/**
 * Runs `call`, reloading the library once if Redis no longer has it. The retry is safe for write Functions:
 * "Function not found" is answered before anything runs (spike §1.1). Concurrent failures share one reload,
 * so a burst after FUNCTION FLUSH sends one FUNCTION LOAD, not one per request.
 */
export async function withLibrary<T>(redis: LibraryHost, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isFunctionNotFound(error)) throw error;
    let reload = reloads.get(redis);
    if (reload === undefined) {
      reload = loadLibrary(redis).finally(() => reloads.delete(redis));
      reloads.set(redis, reload);
    }
    await reload;
    return call();
  }
}
