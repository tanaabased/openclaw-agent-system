#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const directory = new URL('.', import.meta.url);
const control = JSON.parse(readFileSync(new URL('control.json', directory), 'utf8'));
assert.equal(control.ci, true, 'GitHub Actions fixture only.');
const args = process.argv.slice(2);
const endpoint = args.find((arg) => arg.replace(/^\//u, '') === control.endpoint);
if (
  control.paused &&
  endpoint &&
  args.includes('GET') &&
  args.some((arg) => arg.startsWith('since='))
) {
  appendFileSync(
    new URL('reads.jsonl', directory),
    JSON.stringify({ endpoint: control.endpoint, operation: 'comments:1', paused: true }) + '\n',
  );
  // the real installed discovery deadline must cancel this read, not a model-authored result.
  await setTimeout(60_000);
  throw new Error('installed discovery did not cancel the controlled read');
}
assert.notEqual(control.executable, fileURLToPath(import.meta.url));
const child = spawn(control.executable, args, { stdio: 'inherit' });
child.once('error', () => process.exit(1));
child.once('exit', (code) => process.exit(code ?? 1));
