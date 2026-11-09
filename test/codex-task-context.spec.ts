import assert from 'node:assert/strict';

import readCodexTurnTask, { type readCodexTaskOwner } from '../agent/codex-turn-task.ts';
import { codexCurrentTurnContext } from '../agent/codex-turn-context.ts';
import type { connectCodexThreads } from '../agent/codex-thread-client.ts';

describe('agent/codex-task-context', () => {
  const owner = {
    receipt: 'owner',
    currentTurn: { threadId: 'native-chat', turnId: 'native-turn' },
    stage: 'assessment',
    contextRequest: { action: 'context' },
    contextRuntime: 'dispatchRuntime',
    worktree: '/task',
    nativeCwd: '/task',
    workspace: '/workspace',
    codexHome: '/home',
    record: { id: 'owner', worktree: '/task' },
    admission: { repository: { owner: { login: 'org' }, name: 'repo' }, issue: { number: 1 } },
    manifest: { agent: { id: 'agent' } },
    git: { protocol: 'ssh' },
  } as NonNullable<Awaited<ReturnType<typeof readCodexTaskOwner>>>;

  const connection = {
    request: async () => {
      throw new Error('unexpected native request');
    },
    close: async () => {},
  } as Awaited<ReturnType<typeof connectCodexThreads>>;

  it('should recover usable context without a prompt hook, supplied ids, a second context call, or writes', async () => {
    const before = structuredClone(owner);
    const requests: unknown[] = [];
    const result = await codexCurrentTurnContext('/data', 'native-chat', (data, turn) =>
      readCodexTurnTask(data, turn, {
        owner: async (_data, current) => {
          requests.push(current);
          return owner;
        },
        connect: async () => connection,
        skill: async (_request, cwd, name) => {
          assert.equal(cwd, '/task');
          return {
            name,
            path: '/skills/assessment/SKILL.md',
            scope: 'user',
            digest: 'a'.repeat(64),
          };
        },
      }),
    );
    assert.equal(result.status, 'managed-turn-context');
    if (!('assessment' in result)) throw new Error('missing usable context');
    assert.equal(result.assessment?.skill.path, '/skills/assessment/SKILL.md');
    assert.equal(result.evidence.source, 'https://github.com/org/repo/issues/1');
    assert.equal('contextRequest' in result, false);
    assert.equal('feedbackContextRequest' in result, false);
    assert.equal('manifest' in result, false);
    assert.ok(
      requests.every((request) => JSON.stringify(request) === '{"threadId":"native-chat"}'),
    );
    assert.deepEqual(owner, before);
  });

  it('should retain usable task context when exact feedback evidence is unavailable', async () => {
    const selected = { ...owner, stage: 'feedback', feedbackContextRequest: undefined };
    const context = await readCodexTurnTask(
      '/data',
      { threadId: 'native-chat' },
      {
        owner: async () => selected,
        connect: async () => connection,
        skill: async (_request, _cwd, name) => ({
          name,
          path: '/skills/assessment/SKILL.md',
          scope: 'user',
          digest: 'a'.repeat(64),
        }),
      },
    );
    assert.equal(context?.status, 'verified');
    assert.equal(context?.feedback, undefined);
    assert.equal(context?.feedbackLimitation?.code, 'feedback-native-input-unverified');
    assert.equal(context?.evidence.source, 'https://github.com/org/repo/issues/1');
  });

  it('should refuse a native turn that changes during context assembly', async () => {
    let reads = 0;
    await assert.rejects(
      readCodexTurnTask(
        '/data',
        { threadId: 'native-chat' },
        {
          owner: async () =>
            ++reads === 1
              ? owner
              : { ...owner, currentTurn: { ...owner.currentTurn, turnId: 'replacement' } },
          connect: async () => connection,
          skill: async (_request, _cwd, name) => ({
            name,
            path: '/skills/assessment/SKILL.md',
            scope: 'user',
            digest: 'a'.repeat(64),
          }),
        },
      ),
      /turn-context-native-caller-changed/,
    );
  });
});
