import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import selectFeedbackStage from '../agent/feedback-stage.ts';
import type { GitHubNotificationPolicy } from '../channels/github/config-schema.ts';

const skill = {
  name: 'custom:reply',
  path: '/trusted/SKILL.md',
  scope: 'user',
  digest: 'a'.repeat(64),
};
describe('agent/feedback-stage', () => {
  const policy: GitHubNotificationPolicy = {
    schemaVersion: 3,
    runtimes: ['codex'],
    intervalMinutes: 5,
    maxConcurrentItems: 3,
    allowedRepositoryOwners: [],
    issueAssignment: { mode: 'plan', allowed: [], feedback: true },
    reviewRequest: { allowed: [], feedback: true },
  };
  it('should share the bundled default and honor independent skill and guidance overrides', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'feedback-stage-'));
    try {
      await writeFile(join(workspace, 'reply.md'), 'Keep consequential uncertainty.');
      for (const workflow of ['issue-assignment', 'review-request'] as const) {
        const initial = await selectFeedbackStage({
          policy,
          workflow,
          workspace,
          observedAt: 1,
          resolveSkill: async (name) => ({ ...skill, name }),
        });
        assert.equal(initial.selection.requestedSkill, 'agent-system:agent-system-feedback-reply');
        assert.equal(initial.resultContract, 'feedback-result/v1');
        for (const configuration of [
          { skill: 'custom:reply' },
          { guidance: 'Be concise.\nKeep the caveats.' },
          { guidance: { file: 'reply.md' } },
          { skill: 'custom:reply', guidance: { file: 'reply.md' } },
        ]) {
          const custom = structuredClone(policy);
          const owner =
            workflow === 'issue-assignment' ? custom.issueAssignment! : custom.reviewRequest!;
          owner.feedback = { inherit: true, allowed: [], ...configuration };
          const selected = await selectFeedbackStage({
            policy: custom,
            workflow,
            workspace,
            observedAt: 2,
            resolveSkill: async (name) => ({ ...skill, name }),
          });
          assert.equal(
            selected.selection.requestedSkill,
            configuration.skill ?? 'agent-system:agent-system-feedback-reply',
          );
          assert.equal(
            selected.selection.guidance?.content,
            typeof configuration.guidance === 'string'
              ? configuration.guidance
              : configuration.guidance
                ? 'Keep consequential uncertainty.'
                : undefined,
          );
          const other = await selectFeedbackStage({
            policy: custom,
            workflow: workflow === 'issue-assignment' ? 'review-request' : 'issue-assignment',
            workspace,
            observedAt: 2,
            resolveSkill: async (name) => ({ ...skill, name }),
          });
          assert.equal(other.selection.defaultSkill, true);
          assert.equal(other.selection.guidance, undefined);
        }
      }
      await assert.rejects(
        selectFeedbackStage({
          policy,
          workflow: 'issue-assignment',
          workspace,
          observedAt: 1,
          resolveSkill: async () => {
            throw new Error('missing-skill');
          },
        }),
        /missing-skill/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
