import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import CodexDispatchStore from '../agent/codex-dispatch-state.ts';

describe('agent/codex-dispatch-state', () => {
  let root: string;
  let store: CodexDispatchStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dispatch-state-'));
    store = new CodexDispatchStore(root, 'a'.repeat(64));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should initialize absent state and report malformed evidence without replacing it', async () => {
    assert.deepEqual(await store.read(), { version: 1, scope: store.scope, records: [] });
    for (const contents of [
      '{"version":',
      '',
      'null',
      '{"version":2}',
      JSON.stringify({ version: 1, scope: 'b'.repeat(64), records: [] }),
    ]) {
      await store.file.write(contents);
      await assert.rejects(store.read(), { message: 'dispatch-state-invalid' });
      await assert.rejects(
        store.exclusive(async () => assert.fail('corrupt evidence reached a writer')),
        { message: 'dispatch-state-invalid' },
      );
      assert.equal(await readFile(store.path, 'utf8'), contents);
    }
  });

  it('should preserve filesystem denials instead of classifying them as malformed state', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      const denied = Object.assign(new Error('denied'), { code });
      store.file.read = async () => {
        throw denied;
      };
      await assert.rejects(store.read(), (error: unknown) => error === denied);
    }
  });
});
