/**
 * Renders every docs/diagrams/*.mmd to SVG, so the committed SVGs never drift from their sources (see the
 * header of docs/system-design.md). The Mermaid CLI is pinned to one exact version: a floating `@11` would
 * resolve to whatever is newest on the day and re-render unchanged diagrams differently.
 *
 *   pnpm docs:diagrams              re-render next to the sources
 *   pnpm docs:diagrams --out <dir>  render into <dir> instead, e.g. to diff against the committed SVGs
 *
 * Set PUPPETEER_EXECUTABLE_PATH to render with an installed Chrome instead of downloading one.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MERMAID_CLI = '@mermaid-js/mermaid-cli@11.17.0';
const SOURCE_DIR = fileURLToPath(new URL('../docs/diagrams/', import.meta.url));

const { values } = parseArgs({ options: { out: { type: 'string' } } });
// pnpm runs scripts from the repo root; resolve --out against the directory the command was typed in.
const outDir = values.out ? resolve(process.env.INIT_CWD ?? process.cwd(), values.out) : SOURCE_DIR;

const sources = (await readdir(SOURCE_DIR)).filter((file) => file.endsWith('.mmd')).sort();
if (sources.length === 0) throw new Error(`No .mmd files in ${SOURCE_DIR}`);
await mkdir(outDir, { recursive: true });

const chrome = process.env.PUPPETEER_EXECUTABLE_PATH;
const scratch = await mkdtemp(join(tmpdir(), 'flashdrop-diagrams-'));
// Mermaid randomises rough.js control points on every render; a fixed seed makes re-renders byte-identical,
// so re-running this script only changes SVGs whose source changed.
const mermaidConfig = join(scratch, 'mermaid.json');
await writeFile(mermaidConfig, JSON.stringify({ handDrawnSeed: 1 }));
const puppeteerArgs: string[] = ['-c', mermaidConfig];
if (chrome) {
  const config = join(scratch, 'puppeteer.json');
  // Chrome refuses to start its sandbox as root, which is how CI containers run.
  const args = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  await writeFile(config, JSON.stringify({ executablePath: chrome, args }));
  puppeteerArgs.push('-p', config);
}

const failed: string[] = [];
try {
  for (const source of sources) {
    const output = join(outDir, `${basename(source, '.mmd')}.svg`);
    console.log(`${source} -> ${output}`);
    const code = await run([
      'npx',
      '-y',
      MERMAID_CLI,
      '-b',
      'white',
      '-i',
      join(SOURCE_DIR, source),
      '-o',
      output,
      ...puppeteerArgs,
    ]);
    if (code !== 0) failed.push(source);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

if (failed.length > 0) {
  console.error(`Failed to render: ${failed.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`Rendered ${sources.length} diagrams into ${outDir}`);
}

/** Runs a command through the shell, which resolves `npx` to `npx.cmd` on Windows. */
function run(argv: readonly string[]): Promise<number> {
  const command = argv.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)).join(' ');
  const env = chrome ? { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' } : process.env;
  return new Promise((resolvePromise, reject) => {
    spawn(command, { shell: true, stdio: 'inherit', env })
      .on('error', reject)
      .on('exit', (code) => resolvePromise(code ?? 1));
  });
}
