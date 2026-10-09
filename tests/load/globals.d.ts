/*
 * Globals the k6 runtime gives every script that @types/k6 leaves undeclared (k6 2.x: the console, the
 * global timers, Web Crypto's random values and TextEncoder), typed as far as these scripts use them.
 */

declare const console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};

declare function setTimeout(callback: () => void, delayMs: number): number;

declare const crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T;
};

declare class TextEncoder {
  encode(input: string): Uint8Array;
}
