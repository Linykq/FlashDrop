import { config } from 'zod/v4/core';

/*
 * Runs in the browser before any page code (Next.js `instrumentation-client`). Zod compiles object parsers
 * with `new Function` and, on the first parse, probes whether it may: under the edge's Content-Security-Policy,
 * which has no 'unsafe-eval' (infra/caddy/Caddyfile), the browser reports that probe as a `script-src`
 * violation even though Zod catches it and falls back. `jitless` skips the probe and the compiler. Only the
 * admin pages parse with Zod in the browser (the storefront uses type guards, `lib/realtime/protocol.ts`), and
 * their payloads are small, so the interpreted path costs nothing anyone notices. Server code keeps the JIT:
 * this file is never part of the server bundle.
 *
 * `config` alone, from Zod's core, so this entry, which every page loads, carries a few hundred bytes of Zod
 * rather than the library (design-system §14). The setting lives on `globalThis`, so it reaches the copy the
 * admin chunks import.
 */
config({ jitless: true });
