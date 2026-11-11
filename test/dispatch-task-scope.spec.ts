import assert from 'node:assert/strict';
import { dispatchTaskSession, withDispatchTask } from '../agent/dispatch-task-scope.ts';

describe('agent/dispatch-task-scope', () => {
  it('should restrict the scope to its native runtime and clear missing callers', () => {
    assert.equal(dispatchTaskSession('codex'), undefined);
    withDispatchTask('codex', 'issue', () => {
      assert.equal(dispatchTaskSession('codex'), 'issue');
      assert.equal(dispatchTaskSession('openclaw'), undefined);
      withDispatchTask('codex', undefined, () => {
        assert.equal(dispatchTaskSession('codex'), undefined);
      });
      assert.equal(dispatchTaskSession('codex'), 'issue');
    });
    assert.equal(dispatchTaskSession('codex'), undefined);
  });

  it('should retain exact caller scope across overlapping native requests', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await Promise.all([
      withDispatchTask('openclaw', 'first', async () => {
        entered.resolve();
        await release.promise;
        assert.equal(dispatchTaskSession('openclaw'), 'first');
      }),
      withDispatchTask('openclaw', 'second', async () => {
        await entered.promise;
        assert.equal(dispatchTaskSession('openclaw'), 'second');
        release.resolve();
      }),
    ]);
    assert.equal(dispatchTaskSession('openclaw'), undefined);
  });
});
