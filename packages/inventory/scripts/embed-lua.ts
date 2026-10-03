/**
 * Embeds `lua/flashdrop.lua` into `src/library.generated.ts`:
 *
 *   pnpm --filter @flashdrop/inventory embed-lua
 *
 * The library ships as a string inside every bundle (design §14). A plain `import ... from '*.lua'` works
 * only where a bundler loader exists (tsup has one), not under tsx in `pnpm dev` or in Vitest, so the string
 * lives in a generated module that every runtime loads as is. `library.test.ts` fails when the two differ.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const luaPath = fileURLToPath(new URL('../lua/flashdrop.lua', import.meta.url));
const outPath = fileURLToPath(new URL('../src/library.generated.ts', import.meta.url));

/** Escapes what a template literal would otherwise interpret. */
const asTemplate = (text: string) =>
  text.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');

const lua = readFileSync(luaPath, 'utf8').replaceAll('\r\n', '\n');
writeFileSync(
  outPath,
  [
    '// Generated from lua/flashdrop.lua by `pnpm --filter @flashdrop/inventory embed-lua`. Do not edit.',
    '',
    '/** The source of the `flashdrop` Redis Functions library (design §4.2). */',
    `export const LIBRARY_SOURCE = \`${asTemplate(lua)}\`;`,
    '',
  ].join('\n'),
);
