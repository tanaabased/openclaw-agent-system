#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const directory = dirname(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes('check-ref-format') && args.some((arg) => arg.startsWith('790-lock-loss-'))) {
  writeFileSync(join(directory, 'paused'), String(process.pid));
  setTimeout(() => process.exit(70), 60_000);
} else {
  const result = spawnSync(readFileSync(join(directory, 'real-git'), 'utf8').trim(), args, {
    stdio: 'inherit',
    timeout: 60_000,
  });
  process.exit(result.status ?? 71);
}
