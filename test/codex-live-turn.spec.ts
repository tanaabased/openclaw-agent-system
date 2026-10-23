import assert from 'node:assert/strict';

import codexLiveTurn from '../agent/codex-live-turn.ts';

describe('agent/codex-live-turn', () => {
  const input = { threadId: 'issue', turnId: 'assessment', afterItemId: 'boundary' };
  function fixture() {
    const observation = {
      schemaVersion: 1,
      thread: { id: 'issue', kind: 'codex', hostId: 'local', status: { type: 'active' } },
      page: { order: 'newest_first' },
      turns: [{ id: 'assessment', status: 'inProgress', completedAt: null, error: null }],
    };
    const receipt: Record<string, unknown> = {
      id: 'live-read',
      type: 'mcpToolCall',
      server: 'codex_app',
      tool: 'read_thread',
      status: 'completed',
      arguments: { threadId: 'issue', turnLimit: 1, includeOutputs: false },
      result: { content: [{ type: 'text', text: JSON.stringify(observation) }] },
    };
    const entries = [
      {
        turnId: 'assessment',
        item: { id: 'boundary', type: 'commandExecution' } as Record<string, unknown>,
      },
      { turnId: 'assessment', item: receipt },
    ];
    const latest = { id: 'assessment', status: 'interrupted', completedAt: null as number | null };
    const read = codexLiveTurn(async (method, params) => {
      assert.equal(params.threadId, 'issue');
      if (method === 'thread/items/list') {
        assert.equal(params.turnId, 'assessment');
        assert.equal(params.sortDirection, 'asc');
        return params.cursor
          ? { data: entries.slice(1), nextCursor: null }
          : { data: entries.slice(0, 1), nextCursor: 'receipt-page' };
      }
      assert.equal(method, 'thread/turns/list');
      assert.equal(params.limit, 1);
      assert.equal(params.sortDirection, 'desc');
      return { data: [latest] };
    });
    const update = () => {
      receipt.result = { content: [{ type: 'text', text: JSON.stringify(observation) }] };
    };
    return { observation, receipt, entries, latest, read, update };
  }

  it('should verify a fresh owner observation despite an interrupted persisted turn with no timestamp', async () => {
    assert.deepEqual(await fixture().read(input), { status: 'active', receiptId: 'live-read' });
  });

  it('should require a read after the retained boundary rather than reuse an old observation', async () => {
    const f = fixture();
    f.entries.reverse();
    assert.deepEqual(await f.read(input), { status: 'required' });
    f.entries.splice(0, 1);
    assert.deepEqual(await f.read(input), { status: 'required' });
  });

  it('should not trust quoted status, commands or another server as native observations', async () => {
    for (const change of [{ type: 'commandExecution' }, { server: 'other' }, { tool: 'other' }]) {
      const f = fixture();
      Object.assign(f.receipt, change);
      assert.deepEqual(await f.read(input), { status: 'required' });
    }
  });

  it('should reject missing native boundaries and cross-turn history', async () => {
    const f = fixture();
    await assert.rejects(
      f.read({ ...input, afterItemId: 'missing' }),
      /observation-boundary-missing/,
    );
    f.entries[1]!.turnId = 'another';
    await assert.rejects(f.read(input), /observation-history-invalid/);
  });

  it('should preserve transport failure instead of inventing a successful observation', async () => {
    await assert.rejects(
      codexLiveTurn(async () => {
        throw new Error('transport unavailable');
      })(input),
      /transport unavailable/,
    );
  });

  it('should refuse failed, malformed, error or wrong-target native reads', async () => {
    for (const change of [
      { status: 'failed', error: { message: 'ordinary tool failure' }, result: null },
      { result: { content: [{ type: 'text', text: 'not JSON' }] } },
      { result: { isError: true, content: [] } },
      { arguments: { threadId: 'other', turnLimit: 1, includeOutputs: false } },
      { arguments: { threadId: 'issue', turnLimit: 2, includeOutputs: false } },
      { arguments: { threadId: 'issue', turnLimit: 1, includeOutputs: false, hostId: 'other' } },
    ]) {
      const f = fixture();
      Object.assign(f.receipt, change);
      assert.equal((await f.read(input)).status, 'unresolved');
    }
  });

  it('should reject wrong turn, host, thread, ordering and response identities', async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.observation.turns[0]!.id = 'other';
      },
      (f: ReturnType<typeof fixture>) => {
        f.observation.thread.id = 'other';
      },
      (f: ReturnType<typeof fixture>) => {
        f.observation.thread.hostId = 'remote';
      },
      (f: ReturnType<typeof fixture>) => {
        f.observation.thread.kind = 'chatgpt';
      },
      (f: ReturnType<typeof fixture>) => {
        f.observation.schemaVersion = 2;
      },
      (f: ReturnType<typeof fixture>) => {
        f.observation.page.order = 'oldest_first';
      },
    ]) {
      const f = fixture();
      change(f);
      f.update();
      assert.equal((await f.read(input)).status, 'unresolved');
    }
  });

  for (const status of ['completed', 'failed', 'interrupted'])
    it(`should reject an owner-observed ${status} turn even without an end timestamp`, async () => {
      const f = fixture();
      f.observation.turns[0]!.status = status;
      f.update();
      assert.deepEqual(await f.read(input), {
        status: 'unresolved',
        reason: 'native-observation-turn-inactive',
      });
    });

  it('should reject later user direction and native steering after the observation', async () => {
    for (const item of [
      { type: 'userMessage' },
      { type: 'commandExecution', status: 'completed' },
      { type: 'mcpToolCall', status: 'completed' },
      { type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread' },
    ]) {
      const f = fixture();
      f.entries.push({ turnId: 'assessment', item });
      assert.equal((await f.read(input)).status, 'unresolved');
    }
  });

  it('should reject a newer turn or explicit terminal evidence that supersedes the owner read', async () => {
    for (const change of [
      { id: 'later' },
      { status: 'completed' },
      { status: 'failed' },
      { completedAt: 100 },
    ]) {
      const f = fixture();
      Object.assign(f.latest, change);
      assert.equal((await f.read(input)).status, 'unresolved');
    }
  });

  it('should use the latest native read instead of falling back to an older active result', async () => {
    const f = fixture();
    f.entries.push({
      turnId: 'assessment',
      item: { ...f.receipt, id: 'later-read', status: 'failed', result: null },
    });
    assert.equal((await f.read(input)).status, 'unresolved');
  });

  it('should preserve native denials before or after the observation', async () => {
    for (const position of [0, 2]) {
      const f = fixture();
      f.entries.splice(position, 0, {
        turnId: 'assessment',
        item: { type: 'commandExecution', status: 'declined' },
      });
      assert.deepEqual(await f.read(input), { status: 'denied' });
    }
  });
});
