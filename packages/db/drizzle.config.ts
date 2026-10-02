import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @flashdrop/db db:generate` writes reviewed, committed SQL to ./drizzle (design §3). The
// URL is read only by drizzle-kit's database commands (check against a live database, studio), never by
// `generate`. One owner generates migrations, in order: the migrator applies only entries newer than the
// last applied one and never re-reads an applied file (M0 spike, design delta 9).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://flashdrop:flashdrop@127.0.0.1:5433/flashdrop',
  },
  schemaFilter: ['public', 'psp'],
  strict: true,
  verbose: true,
});
