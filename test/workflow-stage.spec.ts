import selectFeedbackStage from '../agent/tasks/feedback/feedback-stage.ts';
import { intakeFixture } from './github-intake-fixture.ts';
import assert from 'node:assert/strict';

import { selectWorkflowStage } from '../agent/tasks/workflow-stage.ts';

describe('agent/workflow-stage', () => {
  const skill = {
    name: 'company:stage',
    path: '/trusted/SKILL.md',
    scope: 'user',
    digest: 'a'.repeat(64),
  };
  it('should reuse the selected reply composer while refreshing explicit configuration and guidance', async () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = {
      inherit: true,
      allowed: [],
      skill: skill.name,
      guidance: 'original constraint',
    };
    let reads = 0;
    const input = {
      policy,
      workflow: 'issue-assignment' as const,
      workspace: '/unused',
      observedAt: 1,
      resolveSkill: async (id: string) => {
        reads++;
        return { ...skill, name: id };
      },
    };
    const first = (await selectFeedbackStage(input)).selection;
    policy.issueAssignment!.feedback.guidance = 'revised constraint';
    const updated = (await selectFeedbackStage({ ...input, retained: first })).selection;
    assert.equal(reads, 1);
    assert.equal(updated.guidance?.content, 'revised constraint');
    assert.deepEqual(updated.skill, first.skill);
    policy.issueAssignment!.feedback.skill = 'different:reply';
    const changed = (await selectFeedbackStage({ ...input, retained: first })).selection;
    assert.equal(changed.skill.name, 'different:reply');
    assert.equal(reads, 2);
  });

  it('should share trusted skill selection', async () => {
    for (const stage of ['assessment', 'implementation', 'review'] as const) {
      const selected = await selectWorkflowStage({
        stage,
        workspace: '/unused',
        observedAt: 123,
        configuration: { skill: skill.name, guidance: 'Follow repository instructions.' },
        resolveSkill: async (id) => {
          assert.equal(id, skill.name);
          return skill;
        },
      });
      assert.equal(selected.stage, stage);
      assert.deepEqual(selected.selection.skill, skill);
      assert.equal(selected.selection.guidance?.content, 'Follow repository instructions.');
      assert.equal(selected.selection.defaultSkill, false);
    }
  });
  it('should resolve bundled assessment and implementation defaults with guidance-only overrides', async () => {
    for (const stage of ['assessment', 'implementation'] as const) {
      const selected = await selectWorkflowStage({
        stage,
        workspace: '/unused',
        observedAt: 123,
        configuration: { guidance: 'Use the repository conventions.\nPreserve existing work.' },
        resolveSkill: async (id) => {
          assert.equal(id, `agent-system:agent-system-task-${stage}`);
          return { ...skill, name: id };
        },
      });
      assert.equal(selected.selection.defaultSkill, true);
      assert.match(selected.selection.guidance!.content, /Preserve existing work/);
    }
  });
  it('should reject unavailable replacements without falling back and leave review execution undefined', async () => {
    const input = { workspace: '/unused', observedAt: 123, resolveSkill: async () => skill };
    await assert.rejects(
      selectWorkflowStage({ ...input, stage: 'review' }),
      /workflow-stage-skill-required/,
    );
    for (const stage of ['assessment', 'implementation', 'review'] as const)
      await assert.rejects(
        selectWorkflowStage({
          ...input,
          stage,
          configuration: { skill: 'missing' },
          resolveSkill: async () => {
            throw new Error('skill-unavailable');
          },
        }),
        /skill-unavailable/,
      );
  });
});
