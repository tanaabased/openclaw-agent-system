import assert from 'node:assert/strict';

import { runSync } from '../scripts/sync-task.mjs';

describe('scripts/sync-task', () => {
  it('should reconcile and build without executing an openclaw provider', async () => {
    const steps: string[] = [];

    await runSync({
      async run(command, args) {
        steps.push(`${command} ${args.join(' ')}`);
      },
    });

    assert.deepEqual(steps, ['bun install --frozen-lockfile', 'bun run build']);
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
      }),
      /build failed/u,
    );

    assert.deepEqual(steps, ['bun install --frozen-lockfile', 'bun run build']);
  });

  it('should not build when dependency installation fails', async () => {
    const steps: string[] = [];
    await assert.rejects(
      runSync({
        async run(command, args) {
          steps.push(`${command} ${args.join(' ')}`);
          throw new Error('dependency installation failed');
        },
      }),
      /dependency installation failed/u,
    );
    assert.deepEqual(steps, ['bun install --frozen-lockfile']);
  });
});
