import assessmentMaterial from '../agent/assessment-material.ts';
import assert from 'node:assert/strict';

import type { AgentManifest } from '../manifest/types.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import taskTurnContext from '../agent/task-turn-context.ts';

describe('agent/task-turn-context', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should supply usable ${runtime} assessment inputs without a saved assessment or another lookup`, async () => {
      const record = { id: 'owner', worktree: '/task' } as SharedDispatchRecord;
      const before = structuredClone(record);
      const manifest = {
        agent: { id: 'agent' },
        github: {
          notifications: {
            issueAssignment: {
              mode: 'plan',
              assessment: { skill: 'custom:assess', guidance: 'Ask before drafting.' },
            },
          },
        },
      } as AgentManifest;
      const context = await taskTurnContext({
        runtime,
        manifest,
        workspace: '/workspace',
        target: 'https://github.com/org/repo/issues/1',
        record,
        stage: 'assessment',
        now: 1,
        resolveSkill: async (name) => ({
          name,
          path: '/skills/assess/SKILL.md',
          scope: 'user',
          digest: 'a'.repeat(64),
        }),
      });
      assert.equal(context.runtime, runtime);
      assert.equal(context.evidence.source, 'https://github.com/org/repo/issues/1');
      assert.equal(context.assessment?.skill.path, '/skills/assess/SKILL.md');
      const guidance = context.assessment?.guidance;
      assert.ok(guidance && 'content' in guidance);
      assert.equal(guidance.content, 'Ask before drafting.');
      assert.equal(context.mode, 'plan');
      assert.equal(context.presentationRequest.operation, 'render');
      assert.ok(context.resultFormat);
      assert.equal(
        'contextMaterials' in assessmentMaterial(context, { action: 'context' }),
        false,
        'ordinary task context must be usable without page reads',
      );
      assert.equal('contextRequest' in context, false);
      assert.equal(context.implementation, undefined);
      assert.deepEqual(record, before);
    });

    it(`should refresh ${runtime} implementation guidance without reentering assessment`, async () => {
      const record = {
        id: 'owner',
        progression: { stage: 'implementation', via: 'work' },
      } as SharedDispatchRecord;
      const manifest = {
        agent: { id: 'agent' },
        github: {
          notifications: { issueAssignment: { implementation: { skill: 'custom:implement' } } },
        },
      } as AgentManifest;
      const names: string[] = [];
      const context = await taskTurnContext({
        runtime,
        manifest,
        workspace: '/workspace',
        target: 'https://github.com/org/repo/issues/1',
        record,
        stage: 'implementation',
        resolveSkill: async (name) => {
          names.push(name);
          return { name, path: '/skills/work/SKILL.md', scope: 'user', digest: 'b'.repeat(64) };
        },
      });
      assert.deepEqual(names, ['custom:implement']);
      assert.equal(context.assessment, undefined);
      assert.equal(context.implementation?.skill.path, '/skills/work/SKILL.md');
      assert.equal(context.issueStage, 'implementation');
    });
  }

  it('should reject inactive owners before reading configured skills', async () => {
    for (const inactive of [{ retired: {} }, { reset: {} }, { supersededBy: 'other' }]) {
      await assert.rejects(
        taskTurnContext({
          runtime: 'codex',
          manifest: { agent: { id: 'agent' } } as AgentManifest,
          workspace: '/workspace',
          target: 'https://github.com/org/repo/issues/1',
          stage: 'assessment',
          record: { id: 'owner', ...inactive } as SharedDispatchRecord,
          resolveSkill: async () => {
            throw new Error('must not resolve');
          },
        }),
        /native-context-owner-unavailable/,
      );
    }
  });
});
