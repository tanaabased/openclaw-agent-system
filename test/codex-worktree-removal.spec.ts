import assert from 'node:assert/strict';
import waitForCodexWorktreeRemoval from '../agent/codex-worktree-removal.ts';

describe('agent/codex-worktree-removal', () => {
  const missing = () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const clock = () => {
    let elapsed = 0;
    return {
      now: () => elapsed,
      sleep: async (ms: number) => {
        assert.ok(ms > 0 && ms <= 1000);
        elapsed += ms;
      },
    };
  };

  it('should finish immediately when the checkout is already gone', async () => {
    assert.equal(
      await waitForCodexWorktreeRemoval('/managed', {
        stat: async () => missing(),
        sleep: async () => assert.fail('no wait after verified removal'),
      }),
      true,
    );
  });

  it('should wait for native removal and finish without using the full budget', async () => {
    const time = clock();
    assert.equal(
      await waitForCodexWorktreeRemoval('/managed', {
        ...time,
        stat: async (path) => {
          assert.equal(path, '/managed');
          if (time.now() >= 3000) missing();
        },
      }),
      true,
    );
    assert.equal(time.now(), 3000);
  });

  it('should stop waiting when the checkout remains for thirty seconds', async () => {
    const time = clock();
    assert.equal(
      await waitForCodexWorktreeRemoval('/managed', { ...time, stat: async () => {} }),
      false,
    );
    assert.equal(time.now(), 30_000);
  });

  it('should accept removal at the deadline', async () => {
    const time = clock();
    assert.equal(
      await waitForCodexWorktreeRemoval('/managed', {
        ...time,
        stat: async () => {
          if (time.now() >= 30_000) missing();
        },
      }),
      true,
    );
    assert.equal(time.now(), 30_000);
  });

  it('should propagate observation errors instead of treating them as removal or timeout', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    await assert.rejects(
      waitForCodexWorktreeRemoval('/managed', {
        stat: async () => {
          throw error;
        },
        sleep: async () => assert.fail('observation failed'),
      }),
      (actual) => actual === error,
    );
  });
});
