import assert from 'node:assert/strict';

import { runSync } from '../scripts/sync-task.mjs';

describe('scripts/sync-task', () => {
  it('should reconcile, build, and verify in order', async () => {
    const steps: string[] = [];

    await runSync({
      async run(command, args) {
        steps.push(`${command} ${args.join(' ')}`);
      },
      async verify() {
        steps.push('verify provider');
      },
    });

    assert.deepEqual(steps, ['bun install --frozen-lockfile', 'bun run build', 'verify provider']);
  });

  it('should stop when a synchronization step fails', async () => {
    const steps: string[] = [];

    await assert.rejects(
      runSync({
        async run(command, args) {
          const step = `${command} ${args.join(' ')}`;
          steps.push(step);
          if (step === 'bun run build') throw new Error('build failed');
        },
        async verify() {
          steps.push('verify provider');
        },
      }),
      /build failed/u,
    );

    assert.deepEqual(steps, ['bun install --frozen-lockfile', 'bun run build']);
  });

  it('should propagate provider verification failures', async () => {
    await assert.rejects(
      runSync({
        async run() {},
        async verify() {
          throw new Error('invalid provider response');
        },
      }),
      /invalid provider response/u,
    );
  });
});
