import assert from 'node:assert/strict';

import { nextIssueStage, selectWorkflowStage } from '../agent/workflow-stage.ts';

describe('agent/workflow-stage', () => {
  const skill = {
    name: 'company:stage',
    path: '/trusted/SKILL.md',
    scope: 'user',
    digest: 'a'.repeat(64),
  };
  it('should share trusted selection and retain a stage-specific result contract', async () => {
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
      assert.equal(selected.resultContract, `${stage}-result/v1`);
      assert.deepEqual(selected.selection.skill, skill);
      assert.equal(selected.selection.guidance?.content, 'Follow repository instructions.');
      assert.equal(selected.selection.defaultSkill, false);
    }
  });
  it('should retain the assessment default without inventing implementation or review defaults', async () => {
    const input = { workspace: '/unused', observedAt: 123, resolveSkill: async () => skill };
    assert.equal(
      (await selectWorkflowStage({ ...input, stage: 'assessment' })).selection.defaultSkill,
      true,
    );
    for (const stage of ['implementation', 'review'] as const) {
      await assert.rejects(
        selectWorkflowStage({ ...input, stage }),
        /workflow-stage-skill-required/,
      );
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
    }
  });
  it('should require usable assessment and an explicit auto recommendation before implementation', () => {
    for (const outcome of ['plan-ready', 'clarification-needed', 'operator-setup-blocker'] as const)
      assert.equal(nextIssueStage('plan', outcome, 'proceed'), 'stop');
    assert.equal(nextIssueStage('work', 'plan-ready'), 'implementation');
    assert.equal(nextIssueStage('auto', 'plan-ready', 'proceed'), 'implementation');
    assert.equal(nextIssueStage('auto', 'plan-ready', 'stop'), 'stop');
    assert.throws(() => nextIssueStage('auto', 'plan-ready'), /workflow-recommendation-required/);
    for (const mode of ['work', 'auto'] as const)
      for (const outcome of ['clarification-needed', 'operator-setup-blocker'] as const)
        assert.equal(nextIssueStage(mode, outcome, 'proceed'), 'stop');
  });
});
