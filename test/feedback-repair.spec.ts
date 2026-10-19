import assert from 'node:assert/strict';
import { selectFeedbackRepair, requireFeedbackRepair } from '../agent/feedback-repair.ts';
import { repairAuthorityDigest } from '../agent/notification-authority.ts';
import type { FeedbackSourceEvent } from '../agent/feedback-state.ts';
import type { GitHubNotificationPolicy } from '../channels/github/config-schema.ts';

const author = { login: 'operator', nodeId: 'U_operator' };
const policy = (): GitHubNotificationPolicy => ({
  schemaVersion: 2,
  runtimes: ['codex', 'openclaw'],
  intervalMinutes: 5,
  maxConcurrentItems: 3,
  allowedRepositoryOwners: [{ login: 'owner', nodeId: 'O_owner' }],
  issueAssignment: {
    mode: 'plan',
    allowed: [],
    feedback: { inherit: false, allowed: [author], repairs: { allowed: [author] } },
  },
});
const event = (): FeedbackSourceEvent => ({
  id: 'a'.repeat(64),
  sourceId: 'C',
  number: 3,
  nodeId: 'I',
  itemType: 'issue',
  source: '{}',
  revision: 'b'.repeat(64),
  createdAt: 1,
  policyDigest: 'c'.repeat(64),
  phase: 'running',
});
describe('agent/feedback-repair', () => {
  it('should require a separate admitted grant and existing pr, preserving legacy reply-only events', async () => {
    const current = policy(),
      source = event();
    const input = {
      event: source,
      policy: current,
      author,
      self: false,
      binding: { thread: 'issue', worktree: '/work' },
      workspace: '/work',
      now: 1,
      resolveSkill: async (name: string) => ({
        name,
        path: '/skills/SKILL.md',
        scope: 'user',
        digest: 'd'.repeat(64),
      }),
    };
    assert.equal(
      await selectFeedbackRepair({
        ...input,
        pullRequest: { pullRequestNodeId: 'PR', pullRequestNumber: 7 },
      }),
      undefined,
    );
    source.repairPolicyDigest = repairAuthorityDigest(current);
    assert.equal(await selectFeedbackRepair(input), undefined);
    assert.equal(
      await selectFeedbackRepair({
        ...input,
        self: true,
        pullRequest: { pullRequestNodeId: 'PR', pullRequestNumber: 7 },
      }),
      undefined,
    );
    source.repair = await selectFeedbackRepair({
      ...input,
      pullRequest: { pullRequestNodeId: 'PR', pullRequestNumber: 7 },
    });
    assert.ok(source.repair);
    assert.match(source.repair.assessment.skill.name, /feedback-assessment/);
    assert.equal(source.repair.implementation, undefined);
    const implementation = await selectFeedbackRepair({
      ...input,
      pullRequest: source.repair.pullRequest,
      implementation: true,
    });
    assert.match(implementation!.implementation!.skill.name, /issue-implementation/);
    source.repair.implementation = implementation!.implementation;
    assert.throws(() => requireFeedbackRepair(source), /decision-required/);
    source.repair.decision = {
      outcome: 'repair',
      rationale: 'Explicit correction.',
      plan: 'Fix parser; run regression.',
    };
    assert.equal(requireFeedbackRepair(source).decision?.outcome, 'repair');
    source.repair.result = {
      outcome: 'done',
      summary: 'fixed',
      fullResult: 'Focused regression passed.',
    };
    assert.throws(() => requireFeedbackRepair(source), /already-finished/);
  });

  it('should defer implementation discovery until work is requested', async () => {
    const current = policy(),
      source = event();
    source.repairPolicyDigest = repairAuthorityDigest(current);
    const input = {
      event: source,
      policy: current,
      author,
      self: false,
      binding: { thread: 'issue' },
      pullRequest: { pullRequestNodeId: 'PR', pullRequestNumber: 7 },
      workspace: '/work',
      now: 1,
      resolveSkill: async (name: string) => {
        if (name.includes('implementation')) throw new Error('implementation-unavailable');
        return { name, path: '/skills/SKILL.md', scope: 'user', digest: 'd'.repeat(64) };
      },
    };
    source.repair = await selectFeedbackRepair(input);
    assert.ok(source.repair?.assessment);
    assert.equal(source.repair.implementation, undefined);
    await assert.rejects(
      selectFeedbackRepair({ ...input, implementation: true }),
      /implementation-unavailable/,
    );
  });
  it('should bind source, selection, owner, pr and grant while ignoring scheduling changes', async () => {
    const current = policy(),
      source = event();
    source.repairPolicyDigest = repairAuthorityDigest(current);
    const input = {
      event: source,
      policy: current,
      author,
      self: false,
      binding: { thread: 'issue', worktree: '/work' },
      pullRequest: { pullRequestNodeId: 'PR', pullRequestNumber: 7 },
      workspace: '/work',
      now: 1,
      resolveSkill: async (name: string) => ({
        name,
        path: '/skills/SKILL.md',
        scope: 'user',
        digest: 'd'.repeat(64),
      }),
    };
    source.repair = await selectFeedbackRepair(input);
    current.intervalMinutes = 60;
    current.maxConcurrentItems = 1;
    current.runtimes.reverse();
    assert.ok(await selectFeedbackRepair(input));
    await assert.rejects(
      selectFeedbackRepair({ ...input, binding: { thread: 'foreign' } }),
      /binding-changed/,
    );
    await assert.rejects(
      selectFeedbackRepair({
        ...input,
        pullRequest: { pullRequestNodeId: 'replacement', pullRequestNumber: 8 },
      }),
      /binding-changed/,
    );
    await assert.rejects(
      selectFeedbackRepair({
        ...input,
        resolveSkill: async (name) => ({
          name,
          path: '/skills/SKILL.md',
          scope: 'user',
          digest: 'e'.repeat(64),
        }),
      }),
      /binding-changed/,
    );
    source.revision = 'e'.repeat(64);
    await assert.rejects(selectFeedbackRepair(input), /binding-changed/);
    source.revision = 'b'.repeat(64);
    current.issueAssignment!.feedback = { inherit: false, allowed: [author] };
    await assert.rejects(selectFeedbackRepair(input), /authority-revoked/);
  });
});
