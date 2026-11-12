import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import openclawIntakeJobs from '../agent/automations/openclaw-intake-policy.ts';
import repositoryScope from '../channels/github/repository-scope.ts';
import parseAgentManifest from '../manifest/parse.ts';

describe('examples/openclaw-notifications-scheduling fixture isolation', () => {
  it('should exclude assignments from concurrent ci scenarios', async () => {
    const source = (
      await readFile('examples/openclaw-notifications-scheduling/tanaabot/agent.yaml', 'utf8')
    ).replaceAll('__RECEIVER_NODE_ID__', 'U_receiver');
    const parsed = parseAgentManifest(source);
    assert.equal(parsed.status, 'valid', JSON.stringify(parsed.diagnostics));
    const decision = repositoryScope(
      parsed.manifest!.github!.notifications!,
      { name: 'big-test-bucket', owner: { login: 'tanaabased', nodeId: 'O_tanaab' } },
      'issue-assignment',
    );
    assert.equal(decision.decision, 'deny');
  });
});

for (const id of [
  'openclaw-issue-conversation',
  'openclaw-pr-journey',
  'openclaw-issue-work-custom',
  'openclaw-issue-auto-plan',
  'openclaw-pr-update',
  'openclaw-pr-discovery',
  'openclaw-issue-intake',
  'openclaw-issue-assessment-recovery',
  'openclaw-issue-assignment-policy',
  'openclaw-notifications-retirement',
  'openclaw-notifications-reset',
  'openclaw-notifications-scheduling',
]) {
  describe(`examples/${id} fixture configuration`, () => {
    it('should accept the prepared fixture and route its supported workflow to the owning runtime', async () => {
      const source = (await readFile(`examples/${id}/tanaabot/agent.yaml`, 'utf8'))
        .replaceAll('__ACTOR_NODE_ID__', 'U_actor')
        .replaceAll('__RECEIVER_NODE_ID__', 'U_receiver')
        .replaceAll('__MILESTONE_NUMBER__', '123');
      const parsed = parseAgentManifest(source);
      assert.equal(parsed.status, 'valid', JSON.stringify(parsed.diagnostics));
      assert.ok(parsed.manifest);
      assert.ok(
        openclawIntakeJobs(parsed.manifest).some((job) => job.id === 'github-issue-assignment'),
      );
      const policy = parsed.manifest.github?.notifications;
      assert.equal(policy?.schemaVersion, 3);
      assert.deepEqual(policy?.runtimes, ['openclaw']);
      assert.equal(
        policy?.issueAssignment?.mode,
        id === 'openclaw-issue-work-custom' ? 'work' : 'plan',
      );
      assert.deepEqual(policy?.issueAssignment?.pullRequest?.recipients, [
        { source: 'assignment-actor', roles: ['assignee'] },
        ...(id === 'openclaw-issue-conversation'
          ? [{ login: 'tanaabot', nodeId: '', reference: '@tanaabot', roles: ['reviewer'] }]
          : []),
      ]);
    });
  });
}

for (const runtime of ['openclaw', 'codex']) {
  describe(`examples/openclaw-project-picker ${runtime} fixture configuration`, () => {
    it('should enable pickup while ordinary assignments remain in plan and exclude the receiving actor', async () => {
      const source = (
        await readFile(`examples/openclaw-project-picker/${runtime}/agent.yaml`, 'utf8')
      )
        .replaceAll('__ACTOR_NODE_ID__', 'U_emori')
        .replaceAll('__MILESTONE_NUMBER__', '123');
      const parsed = parseAgentManifest(source);
      assert.equal(parsed.status, 'valid', JSON.stringify(parsed.diagnostics));
      assert.ok(parsed.manifest);
      const jobs = openclawIntakeJobs(parsed.manifest);
      assert.ok(jobs.some((job) => job.id === 'github-issue-pickup' && job.enabled));
      assert.ok(jobs.some((job) => job.id === 'github-issue-assignment' && job.enabled));
      const policy = parsed.manifest.github!.notifications!;
      assert.deepEqual(policy.runtimes, ['openclaw']);
      assert.equal(policy.issueAssignment!.mode, 'plan');
      assert.deepEqual(
        policy.issueAssignment!.allowed.map((identity) => identity.nodeId),
        ['U_emori'],
      );
      assert.equal(policy.issuePickup!.windowMinutes, 1440);
      assert.equal(policy.issuePickup!.timingError, undefined);
    });
  });
}
