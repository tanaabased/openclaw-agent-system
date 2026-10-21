import assert from 'node:assert/strict';

import codexResetRemoved from '../agent/codex-reset-removed.ts';
import { CodexThreadRpcError, type CodexThreadRequest } from '../agent/codex-thread-client.ts';

const entry = {
  threadId: 'retired',
  worktree: '/owned/checkout',
  retired: { at: 1, by: 'operator' },
};
const missing = new CodexThreadRpcError(-32600, 'thread not loaded: retired');
const absent = async () => {
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
};

describe('agent/codex-reset-removed', () => {
  it('should reconcile only a retired chat and checkout absent from both complete native inventories', async () => {
    const visited: unknown[] = [];
    const request: CodexThreadRequest = async (method, params) => {
      assert.equal(method, 'thread/list');
      assert.ok((params.sourceKinds as string[]).includes('appServer'));
      visited.push([params.archived, params.cursor]);
      return params.cursor
        ? { data: [], nextCursor: null }
        : { data: [{ id: 'other' }], nextCursor: 'next' };
    };
    assert.equal(await codexResetRemoved(request, entry, missing, absent), true);
    assert.deepEqual(visited, [
      [false, undefined],
      [false, 'next'],
      [true, undefined],
      [true, 'next'],
    ]);
  });

  it('should preserve a still-listed chat in either active or archived state', async () => {
    for (const archived of [false, true])
      assert.equal(
        await codexResetRemoved(
          async (_method, params) => ({
            data: params.archived === archived ? [{ id: entry.threadId }] : [],
          }),
          entry,
          missing,
          absent,
        ),
        false,
      );
  });

  it('should preserve live or unresolved ownership, existing checkouts and unrelated native errors', async () => {
    const never: CodexThreadRequest = async () => {
      throw new Error('inventory must not be read');
    };
    assert.equal(
      await codexResetRemoved(never, { ...entry, retired: undefined }, missing, absent),
      false,
    );
    assert.equal(
      await codexResetRemoved(never, { ...entry, threadId: undefined }, missing, absent),
      false,
    );
    assert.equal(
      await codexResetRemoved(never, entry, new Error('transport failed'), absent),
      false,
    );
    assert.equal(await codexResetRemoved(never, entry, missing, async () => ({})), false);
    await assert.rejects(
      codexResetRemoved(never, entry, missing, async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
      /denied/u,
    );
  });

  it('should stop on invalid, incomplete or failed native inventory', async () => {
    await assert.rejects(
      codexResetRemoved(async () => ({ data: [{}] }), entry, missing, absent),
      /native-inventory-invalid/u,
    );
    await assert.rejects(
      codexResetRemoved(async () => ({ data: [], nextCursor: 'repeated' }), entry, missing, absent),
      /native-inventory-incomplete/u,
    );
    await assert.rejects(
      codexResetRemoved(
        async () => {
          throw new Error('native failure');
        },
        entry,
        missing,
        absent,
      ),
      /native failure/u,
    );
  });
});
