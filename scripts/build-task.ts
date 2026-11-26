import codexOpAssets from './codex-op-assets.ts';
import { rm } from 'node:fs/promises';

import { format, resolveConfig } from 'prettier';

import { automationReportSchema } from '../agent/automations/automation-report-schema.ts';

await Bun.write(
  'agent/automations/automation-report.schema.json',
  await format(JSON.stringify(automationReportSchema), {
    ...(await resolveConfig('agent/automations/automation-report.schema.json')),
    parser: 'json',
  }),
);

await codexOpAssets('dist/codex');

const results = await Promise.all([
  Bun.build({
    entrypoints: ['manifest/public.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    packages: 'external',
    naming: 'manifest.js',
  }),
  Bun.build({
    entrypoints: ['index.ts', 'environment/memory-secret-provider-entry.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    packages: 'external',
    sourcemap: 'external',
    minify: false,
    naming: '[name].js',
  }),
  Bun.build({
    entrypoints: ['agent/codex-runtime.ts'],
    outdir: 'dist/codex',
    target: 'node',
    format: 'esm',
    packages: 'bundle',
    plugins: [
      {
        name: 'standalone-codex-no-host-runtime',
        setup(build) {
          build.onResolve({ filter: /^@1password\/sdk-core$/ }, () => ({
            path: './op-sdk-core.cjs',
            external: true,
          }));
          build.onResolve({ filter: /^@napi-rs\/keyring$/ }, () => ({
            path: 'codex-keyring',
            namespace: 'codex-keyring',
          }));
          build.onLoad({ filter: /.*/, namespace: 'codex-keyring' }, () => ({
            contents:
              "import {createRequire} from 'node:module'; const binding = createRequire(import.meta.url)('./keyring.darwin-' + process.arch + '.node'); export const { AsyncEntry, findCredentialsAsync } = binding;",
            loader: 'js',
          }));
          build.onResolve({ filter: /^openclaw(?:\/|$)/ }, (args) => {
            // The existing cleanup reader uses only this portable path resolver.
            if (args.path === 'openclaw/plugin-sdk/state-paths') return;
            throw new Error(
              `Standalone Codex must not import the OpenClaw host: ${args.path} from ${args.importer}`,
            );
          });
        },
      },
    ],
    sourcemap: 'external',
    minify: false,
    naming: '[name].js',
  }),
]);

if (results.some(({ success }) => !success)) {
  for (const result of results) {
    for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
  }
  process.exit(1);
}

await rm('dist/types', { recursive: true, force: true });
const declarations = Bun.spawn(
  ['node', './node_modules/typescript/bin/tsc', '-p', 'manifest/tsconfig.build.json'],
  { stdout: 'inherit', stderr: 'inherit' },
);
if ((await declarations.exited) !== 0) process.exit(1);

export {};
