// Production build: bundles the API and the @kiro/* workspace packages it uses
// (which ship TypeScript source) into dist/server.js. Third-party dependencies
// stay external and are resolved from node_modules at runtime.
import { readFile, rm } from 'node:fs/promises';

import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@kiro/'));

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  logLevel: 'info',
});
