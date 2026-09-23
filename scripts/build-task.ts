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
