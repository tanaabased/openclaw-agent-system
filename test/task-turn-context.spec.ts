import assert from 'node:assert/strict';
import assessmentMaterial from '../agent/tasks/assessment/assessment-material.ts';
import { intakeFixture } from './github-intake-fixture.ts';

import type { SharedDispatchRecord } from '../agent/tasks/dispatch/dispatch-state.ts';
import taskTurnContext from '../agent/tasks/context/task-turn-context.ts';
import type { AgentManifest } from '../manifest/types.ts';

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

  for (const runtime of ['codex', 'openclaw'] as const)
    for (const stage of ['assessment', 'implementation'] as const)
      for (const failure of ['skill', 'guidance'] as const)
        it(`should preserve ${runtime} task facts when ${stage} ${failure} is unavailable`, async () => {
          const record = {
            id: 'owner',
            worktree: '/task',
            ...(stage === 'implementation'
              ? { progression: { stage: 'implementation', via: 'work' } }
              : {}),
          } as SharedDispatchRecord;
          const before = structuredClone(record);
          const context = await taskTurnContext({
            runtime,
            workspace: '/fixture',
            target: 'https://github.com/org/repo/issues/1',
            record,
            stage,
            manifest: {
              schemaVersion: 1,
              agent: { id: 'agent' },
              github: {
                notifications: {
                  ...intakeFixture().policy,
                  issueAssignment: {
                    ...intakeFixture().policy.issueAssignment,
                    mode: 'plan',
                    [stage]: {
                      skill: 'custom:required',
                      ...(failure === 'guidance' ? { guidance: '' } : {}),
                    },
                  },
                },
              },
            } as AgentManifest,
            resolveSkill: async (name) => {
              if (failure === 'skill') throw new Error('dispatch-assessment-skill-unavailable');
              return {
                name,
                path: '/skills/required/SKILL.md',
                scope: 'user',
                digest: 'a'.repeat(64),
              };
            },
          });
          assert.equal(context.status, 'verified');
          assert.equal(context.evidence.source, 'https://github.com/org/repo/issues/1');
          assert.equal(context.project.path, '/task');
          assert.equal(context.mode, stage === 'implementation' ? 'work' : 'plan');
          assert.equal(context[stage], undefined);
          assert.deepEqual(context.contextLimitations, [
            {
              scope: stage,
              code:
                failure === 'skill'
                  ? 'dispatch-assessment-skill-unavailable'
                  : 'dispatch-assessment-guidance-content-invalid',
            },
          ]);
          assert.match(context.instructions, /Do not substitute a default skill/);
          assert.deepEqual(record, before);
        });

  for (const failed of ['assessment', 'reply'] as const)
    it(`should retain verified feedback and the other selection when ${failed} guidance fails`, async () => {
      const feedback = {
        replyTarget: 'https://github.com/org/repo/issues/1#issuecomment-2',
      } as NonNullable<Parameters<typeof taskTurnContext>[0]['feedback']>;
      const context = await taskTurnContext({
        runtime: 'codex',
        manifest: { agent: { id: 'agent' } } as AgentManifest,
        workspace: '/workspace',
        target: 'https://github.com/org/repo/issues/1',
        record: { id: 'owner' } as SharedDispatchRecord,
        stage: 'feedback',
        feedback,
        resolveSkill: async (name) => {
          if ((name.includes('github-reply') ? 'reply' : 'assessment') === failed)
            throw new Error('secret prose must never be returned');
          return { name, path: '/skills/SKILL.md', scope: 'user', digest: 'a'.repeat(64) };
        },
      });
      assert.deepEqual(context.feedback, feedback);
      assert.ok(context[failed === 'assessment' ? 'reply' : 'assessment']);
      assert.equal(context[failed], undefined);
      assert.deepEqual(context.contextLimitations, [
        { scope: failed, code: 'workflow-guidance-unavailable' },
      ]);
      assert.doesNotMatch(JSON.stringify(context), /secret prose/);
    });

  it('should reject inactive owners before reading configured skills', async () => {
    for (const inactive of [{ reset: {} }, { supersededBy: 'other' }]) {
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
