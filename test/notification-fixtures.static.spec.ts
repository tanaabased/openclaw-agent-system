import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import openclawIntakeJobs from '../agent/openclaw-intake-policy.ts';
import parseAgentManifest from '../manifest/parse.ts';

for (const id of [
  'openclaw-issue-journey',
  'openclaw-issue-conversation',
  'openclaw-pr-journey',
  'openclaw-issue-work',
  'openclaw-issue-work-custom',
  'openclaw-issue-auto-work',
  'openclaw-issue-auto-plan',
  'openclaw-pr-recipients',
  'openclaw-pr-update',
  'openclaw-pr-presentation',
  'openclaw-pr-collaboration',
  'openclaw-pr-discovery',
  'openclaw-pr-reply-recovery',
  'openclaw-issue-intake',
  'openclaw-issue-assessment-recovery',
  'openclaw-issue-feedback-policy',
  'openclaw-issue-assignment-policy',
  'openclaw-issue-reactivation',
  'openclaw-notifications-retirement',
  'openclaw-notifications-reset',
  'openclaw-issue-progression',
  'openclaw-issue-decision-recovery',
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
        id === 'openclaw-issue-auto-work'
          ? 'auto'
          : ['openclaw-issue-work', 'openclaw-issue-work-custom'].includes(id)
            ? 'work'
            : 'plan',
      );
      assert.deepEqual(policy?.issueAssignment?.pullRequest?.recipients, [
        { source: 'assignment-actor', roles: ['assignee'] },
        ...(['openclaw-issue-journey', 'openclaw-issue-conversation'].includes(id)
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
      assert.ok(jobs.some((job) => job.id === 'github-project-pickup' && job.enabled));
      assert.ok(jobs.some((job) => job.id === 'github-issue-assignment' && job.enabled));
      const policy = parsed.manifest.github!.notifications!;
      assert.deepEqual(policy.runtimes, ['openclaw']);
      assert.equal(policy.issueAssignment!.mode, 'plan');
      assert.deepEqual(
        policy.issueAssignment!.allowed.map((identity) => identity.nodeId),
        ['U_emori'],
      );
      assert.equal(policy.projectPickup!.windowMinutes, 1440);
      assert.equal(policy.projectPickup!.timingError, undefined);
    });
  });
}
