import assert from 'node:assert/strict';
import liveWorkflowPolicy from '../agent/live-workflow-policy.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('agent/live-workflow-policy', () => {
  it('should apply current mode and actor policy without changing retained evidence', () => {
    const f = intakeFixture();
    const manifest: AgentManifest = {
      schemaVersion: 1,
      agent: { id: 'receiver' },
      github: { username: 'receiver', notifications: f.policy },
    };
    const intake = {
      receiving: f.client.identity,
      repository: f.repository,
      issue: f.item,
      assignment: f.events[0],
    } as unknown as IntakeRecord;
    const before = structuredClone(intake);
    assert.equal(
      liveWorkflowPolicy(manifest, 'codex', intake, 'implementation'),
      'implementation-disabled',
    );
    f.policy.issueAssignment!.mode = 'work';
    assert.equal(liveWorkflowPolicy(manifest, 'codex', intake, 'implementation'), undefined);
    f.policy.issueAssignment!.allowed = [];
    assert.equal(liveWorkflowPolicy(manifest, 'codex', intake), 'assigner-not-approved');
    // feedback uses its own current source-author rule, independently of the original assigner.
    assert.equal(liveWorkflowPolicy(manifest, 'codex', intake, 'feedback'), undefined);
    f.policy.issueAssignment!.enabled = false;
    assert.equal(liveWorkflowPolicy(manifest, 'codex', intake, 'feedback'), undefined);
    assert.deepEqual(intake, before);
  });
});
