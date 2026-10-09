/**
 * Run by `pnpm stack:up` and `pnpm infra:up` before Compose, and by every CI job that starts Compose
 * (design §15): compose.yaml requires each stack secret (`${SESSION_SECRET:?...}`) and has no default for
 * any, because a default in this public repo would let anyone sign an admin session for any stack started
 * with it. This gives `.env` 32 random bytes (base64url) for every one it lacks, holds empty, or holds as
 * `.env.example`'s public development value, and leaves everything else in the file as it was. Compose
 * interpolates from `.env` by itself; a variable set in the shell still wins, as it always does.
 *
 *   tsx tools/ensure-env.ts
 *
 * Values are never printed. The Kafka UI's login is `admin` with KAFKA_UI_PASSWORD from `.env`; Grafana
 * offers no login at all (anonymous viewers only), so its admin password only replaces the image's admin/admin.
 */
import { ensureDotEnv } from './env-file';

const { added, replaced } = ensureDotEnv();
if (added.length > 0) console.log(`.env: generated ${added.join(', ')}`);
if (replaced.length > 0) console.log(`.env: replaced the public development value of ${replaced.join(', ')}`);
