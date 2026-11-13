import { format, resolveConfig } from 'prettier';

import { automationReportSchema } from '../agent/automations/automation-report-schema.ts';

await Bun.write(
  'agent/automations/automation-report.schema.json',
  await format(JSON.stringify(automationReportSchema), {
    ...(await resolveConfig('agent/automations/automation-report.schema.json')),
    parser: 'json',
  }),
);

const results = await Promise.all([
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

export {};
