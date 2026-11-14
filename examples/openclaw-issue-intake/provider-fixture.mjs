#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const control = JSON.parse(readFileSync(new URL('control.json', import.meta.url), 'utf8'));
assert.equal(control.ci, true, 'GitHub Actions fixture only.');
assert.match(control.title, /^Agent System intake flow \d+-\d+$/u);
assert.notEqual(control.executable, fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const query = args.findIndex(
  (arg, index) => args[index - 1] === '-f' && arg.startsWith('q=assignee:'),
);
if (
  args[0] === 'api' &&
  args.some((arg) => arg.replace(/^\//u, '') === 'search/issues') &&
  args.includes('GET') &&
  query >= 0
) {
  // keep real search and pagination, but do not let neighboring scenarios occupy the held slots.
  args[query] += ` repo:tanaabased/big-test-bucket in:title "${control.title}"`;
}
const child = spawn(control.executable, args, { stdio: 'inherit' });
child.once('error', () => process.exit(1));
child.once('exit', (code) => process.exit(code ?? 1));
