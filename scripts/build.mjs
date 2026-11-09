import { build } from 'esbuild';
import { build as buildWeb } from 'vite';
import { readFile, mkdir } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await mkdir(new URL('../dist', import.meta.url), { recursive: true });
await build({
  entryPoints: ['apps/nihao/server/start.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  tsconfig: 'tsconfig.runtime.json',
  external: Object.keys(manifest.dependencies),
  logLevel: 'info',
});
await buildWeb({ configFile: 'apps/nihao/web/vite.config.ts' });
