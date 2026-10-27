import assert from 'node:assert/strict';

import { selectWorkflowStage } from '../agent/workflow-stage.ts';

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
