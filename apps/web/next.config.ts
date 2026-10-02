import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { z } from 'zod';

const repoRoot = path.join(import.meta.dirname, '../..');

/*
 * Where `api` listens, for the `pnpm dev` rewrite below. Everything web itself fetches from api (Server
 * Components, the proxy's product check, the `/uploads` proxy for the image optimizer) reads API_INTERNAL_URL
 * lazily at request time (spike delta 13), so one image works against any api address.
 */
function apiOrigin(): string {
  return z
    .url({ protocol: /^https?$/, error: 'API_INTERNAL_URL must be an http(s) URL' })
    .transform((value) => new URL(value))
    .refine(
      (url) => url.pathname === '/' && url.search === '',
      'API_INTERNAL_URL must be an origin, without a path',
    )
    .parse(process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000').origin;
}

export default function config(phase: string): NextConfig {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  // `pnpm dev` reads the repo's .env like api's dev script does (--env-file-if-exists=../../.env), so both
  // share SESSION_SECRET. Variables already set win. Builds and the standalone server never read it.
  const dotenv = path.join(repoRoot, '.env');
  if (dev && existsSync(dotenv)) process.loadEnvFile(dotenv);

  return {
    cacheComponents: true,
    // `next dev` would otherwise write AGENTS.md and CLAUDE.md here when it detects a coding agent; the repo's
    // own CLAUDE.md already points agents at the docs.
    agentRules: false,
    output: 'standalone',
    // The repo root, so the standalone output traces the pnpm workspace (spike §3.7).
    outputFileTracingRoot: repoRoot,
    // Caddy compresses at the edge (zstd or gzip, infra/caddy/Caddyfile); gzipping in Node as well would cost
    // the server CPU and hand Caddy a body it can no longer encode as zstd.
    compress: false,
    experimental: {
      // Server stack traces in the logs point at the source (SD §12) when Node runs with
      // --enable-source-maps (NODE_OPTIONS in the web image's runtime stage).
      serverSourceMaps: true,
    },
    // Workspace packages export raw TypeScript.
    transpilePackages: ['@flashdrop/config', '@flashdrop/contracts', '@flashdrop/domain'],
    images: {
      // Product photos are api's content-addressed files, referenced same-origin as `/uploads/<sha256>.jpg`.
      // The optimizer fetches a same-origin source through web's own routing, which reaches the request-time
      // proxy in app/uploads/[key]/route.ts, so the browser never sees api's address and no private-address
      // exception is needed (design-system §11.4, Appendix B item 3).
      localPatterns: [{ pathname: '/uploads/**', search: '' }],
      minimumCacheTTL: 31_536_000,
    },
    // In `pnpm dev` the browser talks to web only, so web forwards api's paths. A build leaves it out: its
    // destination would be fixed into the image, and behind Caddy, which routes `/api/*` to api, the only
    // requests left to reach it would be stray ones (a bare `/api`) proxied to a port nothing listens on.
    async rewrites() {
      return dev ? [{ source: '/api/:path*', destination: `${apiOrigin()}/api/:path*` }] : [];
    },
  };
}
