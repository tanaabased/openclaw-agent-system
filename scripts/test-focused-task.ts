import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dir, '..');
const run = (command: string[]) =>
  Bun.spawn(command, { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited;

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { build: { type: 'boolean' }, grep: { type: 'string' } },
  });
  if (!positionals.length) throw new Error('select explicit component test files');
  const files = positionals.map((file) => resolve(root, file));
  for (const file of files) {
    if (!file.endsWith('.component.spec.ts') || !(await stat(file)).isFile())
      throw new Error(`not a component test file: ${file}`);
  }
  if (values.build) {
    const result = await run([process.execPath, 'run', 'build']);
    if (result) process.exit(result);
  }
  process.exit(
    await run([
      'node',
      '--import',
      'tsx',
      './node_modules/mocha/bin/mocha.js',
      '--no-config',
      '--no-package',
      '--timeout',
      '10000',
      '--reporter',
      './scripts/test-timing-reporter.cjs',
      '--fail-zero',
      ...(values.grep === undefined ? [] : ['--grep', values.grep]),
      ...files,
    ]),
  );
} catch (error) {
  process.stderr.write(
    `focused tests: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
