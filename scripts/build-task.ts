const result = await Bun.build({
  entrypoints: ['index.ts'],
  outdir: 'dist',
  target: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: 'external',
  minify: false,
  naming: '[name].js',
});

if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
  process.exit(1);
}

export {};
