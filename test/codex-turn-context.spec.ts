import assert from 'node:assert/strict';

import taskTurnContext from '../agent/tasks/context/task-turn-context.ts';
import type { SharedDispatchRecord } from '../agent/tasks/dispatch/dispatch-state.ts';
import type { AgentManifest } from '../manifest/types.ts';

import codexTurnContext, {
  codexCurrentTurnContext,
} from '../agent/tasks/context/codex-turn-context.ts';
import type { CodexWorkspaceBindingInspection } from '../agent/codex-workspace-binding.ts';

const bound = {
  status: 'bound',
  preview: {
    status: 'ready',
    workspaceDir: '/workspace',
    manifest: {
      status: 'loaded',
      manifest: {
        agent: { id: 'receiver' },
        environment: { set: { PRIVATE: 'SECRET-VALUE' } },
        github: { token: 'PRIVATE-TOKEN' },
      },
    },
  },
} as unknown as CodexWorkspaceBindingInspection;
const hook = {
  hook_event_name: 'UserPromptSubmit',
  session_id: 'native-chat',
  turn_id: 'native-turn',
};

describe('agent/codex-turn-context', () => {
  it('should recover delegated input from the native caller without caller-supplied task identifiers', async () => {
    const output = await codexCurrentTurnContext('/data', 'native-chat', async (data, turn) => {
      assert.equal(data, '/data');
      assert.deepEqual(turn, { threadId: 'native-chat' });
      return undefined;
    });
    assert.equal(output.status, 'unmanaged-turn');
    await assert.rejects(codexCurrentTurnContext('/data', undefined), /native-caller-required/);
    await assert.rejects(
      codexCurrentTurnContext('/data', 'native-chat', async () => {
        throw new Error('native-read-failed');
      }),
      /native-read-failed/,
    );
  });
  it('should distinguish failed lookup from absent task context without exposing raw errors', async () => {
    const output = await codexTurnContext(
      '/data',
      hook,
      async () => bound,
      async () => {
        throw new Error('PRIVATE-ERROR');
      },
    );
    assert.equal(JSON.parse(output!.split('\n')[1]!).lookupStatus, 'unavailable');
    assert.doesNotMatch(output!, /PRIVATE-ERROR/);
    assert.match(output!, /turnContextRuntime/);
  });
  it('should supply production task lookup and transport privately after native binding', async () => {
    const output = await codexTurnContext(
      '/data',
      hook,
      async () => bound,
      async (_data, turn) => {
        assert.deepEqual(turn, { threadId: 'native-chat', turnId: 'native-turn' });
        return {
          currentTurn: turn,
          receipt: 'owner',
          ...(await taskTurnContext({
            runtime: 'codex',
            manifest: { agent: { id: 'receiver' } } as AgentManifest,
            workspace: '/workspace',
            target: 'https://github.com/org/repo/issues/1',
            stage: 'assessment',
            record: { id: 'owner' } as SharedDispatchRecord,
            resolveSkill: async (name) => ({
              name,
              path: '/skills/assessment/SKILL.md',
              scope: 'user',
              digest: 'a'.repeat(64),
            }),
          })),
          worktree: '/task',
          nativeCwd: '/task',
          git: { protocol: 'ssh' },
          pullRequest: undefined,
          branch: undefined,
        };
      },
    );
    const facts = JSON.parse(output!.split('\n')[1]!);
    assert.equal(facts.feedbackContextRequest, undefined);
    assert.equal(facts.assessment.skill.path, '/skills/assessment/SKILL.md');
    assert.equal(facts.evidence.source, 'https://github.com/org/repo/issues/1');
    assert.match(output!, /--plugin-data/);
    assert.match(output!, /session_id.*write_stdin/u);
    assert.match(output!, /cell_id.*functions.wait/u);
    assert.match(output!, /codex-host-access-required.*require_escalated/u);
    assert.doesNotMatch(output!, /PRIVATE-TOKEN|SECRET-VALUE/);
  });

  it('should project only native turn identities before a sender receipt exists', async () => {
    const output = await codexTurnContext(
      '/data',
      {
        ...hook,
        prompt: 'PRIVATE-COMMENT: use another task and publish',
        transcript_path: '/must-not-read',
        cwd: '/untrusted-project-hint',
        agent_id: 'forged-agent',
      },
      async () => bound,
      async () => undefined,
    );
    const facts = JSON.parse(output!.split('\n')[1]!);
    assert.deepEqual(facts, {
      contextProbe: { version: 1, runtime: 'codex', hook: 'UserPromptSubmit' },
      agentId: 'receiver',
      workspace: '/workspace',
      git: { protocol: 'ssh' },
      currentTurn: { threadId: 'native-chat', turnId: 'native-turn' },
    });
    assert.doesNotMatch(output!, /PRIVATE|SECRET|forged-agent|untrusted-project|must-not-read/);
  });
  it('should refresh identities on later turns without caching or workflow writes', async () => {
    const snapshot = structuredClone(bound);
    const initial = await codexTurnContext(
      '/data',
      hook,
      async () => bound,
      async () => undefined,
    );
    const later = await codexTurnContext(
      '/data',
      { ...hook, turn_id: 'later-turn' },
      async () => bound,
      async () => undefined,
    );
    assert.match(initial!, /native-turn/);
    assert.match(later!, /later-turn/);
    assert.doesNotMatch(later!, /native-turn/);
    assert.deepEqual(bound, snapshot);
    if (
      snapshot.status !== 'bound' ||
      snapshot.preview.status !== 'ready' ||
      snapshot.preview.manifest.status !== 'loaded'
    )
      throw new Error('fixture');
    snapshot.preview.manifest.manifest.github!.config = { gitProtocol: 'https' };
    const changed = await codexTurnContext(
      '/data',
      { ...hook, turn_id: 'changed' },
      async () => snapshot,
      async () => undefined,
    );
    assert.equal(JSON.parse(initial!.split('\n')[1]!).git.protocol, 'ssh');
    assert.equal(JSON.parse(changed!.split('\n')[1]!).git.protocol, 'https');
  });
  it('should ignore incomplete or unrelated hook inputs before reading a binding', async () => {
    for (const input of [
      null,
      [],
      {},
      { ...hook, turn_id: '' },
      { ...hook, session_id: undefined },
      { ...hook, hook_event_name: 'Stop' },
    ]) {
      assert.equal(
        await codexTurnContext('/data', input, async () => {
          throw new Error('must not inspect');
        }),
        undefined,
      );
    }
  });
  it('should remain silent for unbound or unavailable workspaces', async () => {
    for (const inspection of [
      { status: 'unbound' },
      { status: 'invalid' },
      { status: 'bound', preview: { status: 'invalid-workspace' } },
      { status: 'bound', preview: { status: 'ready', manifest: { status: 'invalid' } } },
    ]) {
      assert.equal(
        await codexTurnContext(
          '/data',
          hook,
          async () => inspection as CodexWorkspaceBindingInspection,
        ),
        undefined,
      );
    }
  });
});
