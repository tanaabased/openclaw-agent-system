import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { inspect } from 'node:util';

import waitForConcurrencyState from './wait-for-state.ts';

async function main(): Promise<void> {
  const phase = process.argv[2];
  assert.ok(phase === 'entered' || phase === 'limited');
  const call = (args: string[]) =>
    JSON.parse(execFileSync('openclaw', args, { encoding: 'utf8', timeout: 15_000 }));
  await waitForConcurrencyState({
    phase,
    gate: join(tmpdir(), 'notification-concurrency'),
    channelState: join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'tanaab/agent-system/notification-data/channels',
    ),
    read: (path) => readFile(path, 'utf8'),
    sessions: () =>
      call([
        'gateway',
        'call',
        'sessions.list',
        '--params',
        '{"agentId":"notification-data"}',
        '--json',
      ]),
    status: () =>
      call(['agent-system', 'notifications', 'status', '--agent', 'notification-data', '--json']),
    clock: Date.now,
    sleep: setTimeout,
  });
}

main().catch(async (error: unknown) => {
  process.stderr.write(`${inspect(error)}\n`);
  const gatewayLog = await readFile(join(tmpdir(), 'gateway.log'), 'utf8').catch(() => '');
  const failures = gatewayLog
    .split('\n')
    .filter((line) => /error|failed|provider|model|transport/iu.test(line))
    .slice(-60)
    .map((line) => line.slice(0, 2_000));
  process.stderr.write(`Recent Gateway diagnostics:\n${failures.join('\n')}\n`);
  process.exitCode = 1;
});
