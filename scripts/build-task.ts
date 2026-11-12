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
