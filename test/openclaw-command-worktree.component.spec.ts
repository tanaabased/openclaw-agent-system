import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import resolveOpenClawCommandWorktree from '../agent/tasks/context/openclaw-command-worktree.ts';
import OpenClawDispatchStore, {
  type OpenClawDispatchRecord,
} from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import { intakeLocation } from '../channels/github/intake/record-store.ts';

describe('OpenClaw command worktree ownership', () => {
  it('should require a verified assignment and matching current native checkout', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'command-worktree-')));
    try {
      const agent = { agentId: 'receiver', workspaceDir: join(root, 'agent') };
      const worktree = join(root, 'checkout');
      await mkdir(agent.workspaceDir);
      await mkdir(worktree);
      const dispatchRoot = join(root, 'dispatch');
      const taskContext = {
        storageBackend: 'file' as const,
        root: join(root, 'intake'),
        namespace: root,
      };
      const binding = { sessionKey: 'agent:receiver:issue:one', sessionId: 'incarnation' };
      const session = { sessionId: binding.sessionId, spawnedCwd: worktree };
      let observed: typeof session & { archivedAt?: number; execHost?: string } = session;
      const dependencies = { taskContext, dispatchRoot, readSession: async () => observed };
      const verify = () => resolveOpenClawCommandWorktree(dependencies, agent, binding);
      const { scope } = intakeLocation({ runtime: 'openclaw', ...taskContext, ...agent });
      const store = new OpenClawDispatchStore(dispatchRoot, scope);
      const record: OpenClawDispatchRecord = {
        id: 'a'.repeat(64),
        intakeId: 'b'.repeat(64),
        issueKey: 'c'.repeat(64),
        sourceThreadId: 'agent:receiver:automation:intake',
        createdAt: 1,
        manifestDigest: 'manifest',
        context: '{}',
        routing: '{}',
        worktree,
        threadId: binding.sessionKey,
        effective: { status: 'verified' },
        request: {
          key: binding.sessionKey,
          idempotencyKey: 'creation',
          agentId: agent.agentId,
          cwd: worktree,
          label: '#1: ASSESS',
          category: 'issues',
          model: 'provider/model',
          thinkingLevel: 'high',
        },
        sessionCreation: {
          attempted: true,
          verified: true,
          sessionId: binding.sessionId,
          sourceSessionId: 'source',
          sourceRunId: 'run',
          sourceToolCallId: 'call',
        },
      };

      assert.equal(await verify(), undefined);
      await store.exclusive(async (state, save) => {
        state.records.push(record);
        await save();
      });
      assert.equal(await verify(), worktree);
      assert.equal(
        await resolveOpenClawCommandWorktree(dependencies, { ...agent, agentId: 'peer' }, binding),
        undefined,
      );
      observed = { ...session, sessionId: 'replacement' };
      assert.equal(await verify(), undefined);
      observed = { ...session, archivedAt: 1 };
      assert.equal(await verify(), undefined);
      observed = { ...session, spawnedCwd: agent.workspaceDir };
      assert.equal(await verify(), undefined);
      observed = { ...session, execHost: 'node' };
      assert.equal(await verify(), undefined);
      observed = session;
      await store.exclusive(async (state, save) => {
        state.records[0]!.reset = { at: 2, by: 'operator' };
        await save();
      });
      assert.equal(await verify(), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
