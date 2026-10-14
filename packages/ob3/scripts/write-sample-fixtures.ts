// Writes the sample credentials, issuer profile, status list and baked badges to fixtures/sample.
//
//   pnpm --filter @credforge/ob3 fixtures [-- --base-url https://credforge.app/ob3-sample] [--out dir]
//
// `--out` writes somewhere else (e.g. a sample for a temporary tunnel URL) and leaves the committed
// fixtures alone. See the package README ("Checking with the 1EdTech validator").

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildSampleFixtures, DEFAULT_SAMPLE_BASE_URL } from './sample-fixtures';

const { values } = parseArgs({
  // pnpm passes the `--` separator through to the script.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    'base-url': { type: 'string', default: DEFAULT_SAMPLE_BASE_URL },
    out: { type: 'string' },
  },
});
const baseUrl = values['base-url'] ?? DEFAULT_SAMPLE_BASE_URL;
// Relative --out paths are relative to where pnpm was run, not to this package.
const outDir = values.out
  ? resolve(process.env.INIT_CWD ?? process.cwd(), values.out)
  : fileURLToPath(new URL('../fixtures/sample/', import.meta.url));

// The output folder is replaced wholesale, so only ever replace an earlier sample.
const isEarlierSample = (dir: string) =>
  existsSync(join(dir, 'credential.json')) && existsSync(join(dir, 'public'));
if (existsSync(outDir) && readdirSync(outDir).length > 0 && !isEarlierSample(outDir)) {
  console.error(
    `Refusing to replace ${outDir}: it is not empty and doesn't hold an earlier sample.`,
  );
  process.exit(1);
}

const files = await buildSampleFixtures(baseUrl);
rmSync(outDir, { recursive: true, force: true });
for (const [path, content] of files) {
  const target = join(outDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
console.log(`Wrote ${files.size} files to ${outDir} for ${baseUrl}`);
console.log(`Serve ${join(outDir, 'public')} at ${baseUrl} (JSON documents as application/json).`);
