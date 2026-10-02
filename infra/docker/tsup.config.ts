/**
 * Bundles the entry points of the `node` image (design §14, image checklist). Dockerfile.node runs it from
 * the repo root:
 *
 *   APPS="api worker payment-mock" pnpm exec tsup --config infra/docker/tsup.config.ts
 *
 * Workspace packages export raw TypeScript, which Node does not run from node_modules, so they are bundled
 * into each entry. Every third-party package stays external and is installed into the image for Linux:
 * that keeps the native bindings (@confluentinc/kafka-javascript, sharp) prebuilt for the platform, and
 * leaves packages that load their own files at runtime (pino's transports, for example) intact.
 *
 * Each bundle keeps the depth of its source (`apps/api/src/main.ts` -> `out/apps/api/dist/main.js`) and the
 * image mirrors the repo under /app, so a path an entry file resolves from `import.meta.url` points at the
 * same place in the image as in the source tree. Code inlined from other modules resolves against the
 * entry's location instead, which is why the migrate job passes its directories explicitly.
 */
import type { Options } from 'tsup';

const APP_DIR = /^[a-z][a-z0-9-]*$/;

/** `APPS`: space-separated directories under `apps/` to bundle (the image's build arg). */
function appsToBundle(value = process.env.APPS ?? 'api'): string[] {
  const apps = value.split(/\s+/).filter((app) => app !== '');
  if (apps.length === 0 || !apps.every((app) => APP_DIR.test(app))) {
    throw new Error(`APPS must name directories under apps/, such as "api worker"; got "${value}"`);
  }
  return apps;
}

export default {
  entry: {
    ...Object.fromEntries(appsToBundle().map((app) => [`apps/${app}/dist/main`, `apps/${app}/src/main.ts`])),
    // The one-shot `migrate` service runs both: Drizzle migrations, then the demo seed (compose.yaml).
    'packages/db/dist/cli/migrate': 'packages/db/src/cli/migrate.ts',
    'packages/db/dist/cli/seed': 'packages/db/src/cli/seed.ts',
  },
  outDir: 'out',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // One self-contained file per entry: shared chunks would land in outDir's root, where `import.meta.url`
  // resolves differently from the code's source location.
  splitting: false,
  sourcemap: true,
  skipNodeModulesBundle: true,
  noExternal: [/^@flashdrop\//],
  // The Redis Functions library is imported as a string, so it ships inside the bundle (design §14).
  loader: { '.lua': 'text' },
  // Keep `node:` specifiers as written; some built-ins (node:sqlite, node:test) exist only under them.
  removeNodeProtocol: false,
} satisfies Options;
