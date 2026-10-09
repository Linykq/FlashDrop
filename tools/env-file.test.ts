import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSecrets, STACK_SECRETS, stackSecret } from './env-file';

/** Distinct, recognisable values in the order they are generated. */
function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `generated-${n}`;
  };
}

describe('ensureSecrets', () => {
  it('writes every stack secret into a missing .env, with a password-matching PSP_DATABASE_URL', () => {
    const { text, added, replaced } = ensureSecrets('', counter());
    const env = parseEnv(text);
    expect(added).toEqual(STACK_SECRETS);
    expect(replaced).toEqual([]);
    for (const name of STACK_SECRETS) expect(env[name]).toMatch(/^generated-\d$/);
    expect(new Set(STACK_SECRETS.map((name) => env[name])).size).toBe(STACK_SECRETS.length);
    expect(env.PSP_DATABASE_URL).toBe(
      `postgres://flashdrop_psp:${env.PSP_DB_PASSWORD}@127.0.0.1:5433/flashdrop`,
    );
  });

  it('replaces the public development values of a .env copied from .env.example, and nothing else', () => {
    const copied = [
      '# Auth',
      'SESSION_SECRET=dev-only-session-secret-not-for-production',
      'LOG_LEVEL=debug',
      'PSP_DB_PASSWORD=dev-only-psp-db-password',
      'PSP_DATABASE_URL=postgres://flashdrop_psp:dev-only-psp-db-password@127.0.0.1:5433/flashdrop',
      'export TEST_ROUTES_SECRET = dev-only-test-routes-secret',
      '',
    ].join('\r\n');
    const { text, added, replaced } = ensureSecrets(copied, counter());
    const env = parseEnv(text);

    expect(replaced).toEqual(['SESSION_SECRET', 'TEST_ROUTES_SECRET', 'PSP_DB_PASSWORD']);
    expect(added).toEqual([
      'REVALIDATE_SECRET',
      'APP_DB_PASSWORD',
      'PSP_API_KEY',
      'KAFKA_UI_PASSWORD',
      'GRAFANA_ADMIN_PASSWORD',
    ]);
    expect(text).not.toContain('dev-only-');
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.PSP_DATABASE_URL).toBe(
      `postgres://flashdrop_psp:${env.PSP_DB_PASSWORD}@127.0.0.1:5433/flashdrop`,
    );
    // Rewritten in place, in the file's own line endings; the missing ones are appended after a comment.
    const lines = text.split('\r\n');
    expect(lines.slice(0, 3)).toEqual(['# Auth', `SESSION_SECRET=${env.SESSION_SECRET}`, 'LOG_LEVEL=debug']);
    expect(lines).toContain(`TEST_ROUTES_SECRET=${env.TEST_ROUTES_SECRET}`);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
  });

  it('keeps values someone chose, and changes nothing when every secret is there', () => {
    const chosen = `${STACK_SECRETS.map((name) => `${name}=chosen-${name.toLowerCase()}`).join('\n')}\n`;
    expect(ensureSecrets(chosen, counter())).toEqual({ text: chosen, added: [], replaced: [] });
  });

  it('fills a secret that is assigned but empty', () => {
    const present = STACK_SECRETS.filter((name) => name !== 'REVALIDATE_SECRET')
      .map((name) => `${name}=kept`)
      .join('\n');
    const { text, added } = ensureSecrets(`${present}\nREVALIDATE_SECRET=\n`, counter());
    expect(added).toEqual(['REVALIDATE_SECRET']);
    expect(parseEnv(text).REVALIDATE_SECRET).toBe('generated-1');
    expect(text.match(/REVALIDATE_SECRET=/g)).toHaveLength(1);
  });

  it('gives a chosen PSP_DATABASE_URL the new password and keeps its host', () => {
    const { text } = ensureSecrets(
      'PSP_DATABASE_URL=postgres://flashdrop_psp:old@db.internal:6543/x\n',
      counter(),
    );
    const env = parseEnv(text);
    expect(env.PSP_DATABASE_URL).toBe(`postgres://flashdrop_psp:${env.PSP_DB_PASSWORD}@db.internal:6543/x`);
  });
});

describe('stackSecret', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fd-env-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the shell's value to .env's, as Compose does", () => {
    const path = join(dir, '.env');
    writeFileSync(path, 'TEST_ROUTES_SECRET=from-file\n');
    vi.stubEnv('TEST_ROUTES_SECRET', '');
    expect(stackSecret('TEST_ROUTES_SECRET', path)).toBe('from-file');
    vi.stubEnv('TEST_ROUTES_SECRET', 'from-shell');
    expect(stackSecret('TEST_ROUTES_SECRET', path)).toBe('from-shell');
  });

  it('fails with the fix when neither has it', () => {
    vi.stubEnv('TEST_ROUTES_SECRET', '');
    expect(() => stackSecret('TEST_ROUTES_SECRET', join(dir, 'missing.env'))).toThrow(/pnpm stack:up/);
  });
});
