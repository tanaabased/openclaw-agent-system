import assert from 'node:assert/strict';

import dispatchInspection, { dispatchInspectionSummary } from '../agent/dispatch-inspection.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import type { ManagedIssue } from '../agent/managed-issue.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

describe('agent/dispatch-inspection', () => {
  function fixture() {
    const f = intakeFixture();
    const admitted: ManagedIssue = {
      version: 1,
      id: 'a'.repeat(64),
      scope: 'scope',
      workspaceDir: '/workspace',
      agentId: 'receiver',
      host: 'github.com',
      receiving: f.client.identity,
      repository: f.repository,
      issue: f.item,
      assignment: { ...f.events[0]!, event: 'assigned' },
      evidence: {
        policyDigest: 'policy',
        mode: 'plan',
        open: true,
        assigned: true,
        repositoryReadable: true,
        ownerPinned: true,
        actorPinned: true,
      },
      observedAt: baseline,
      admittedAt: baseline,
      status: 'admitted',
      requiresRevalidation: true,
    };
    const records = ['b', 'c', 'd'].map((digit): SharedDispatchRecord => ({
      id: digit.repeat(64),
      intakeId: admitted.id,
      issueKey: 'e'.repeat(64),
      sourceThreadId: 'coordinator',
      phase: 'routing',
      createdAt: baseline,
      manifestDigest: 'manifest',
      lifecycleCheckedAt: baseline,
    }));
    return { admitted, records };
  }
  it('should select an exact repository and item without confusing issue and pr numbers', () => {
    const { admitted, records } = fixture();
    const owners = records.map((r) => ({
      ...r,
      delivery: { pullRequest: { pullRequestNumber: 7 } },
    }));
    assert.equal(
      dispatchInspection(owners, [admitted], { target: 'OWNER/repo#3' }).records.length,
      3,
    );
    assert.equal(
      dispatchInspection(owners, [admitted], { target: 'other/repo#3' }).records.length,
      0,
    );
    assert.equal(
      dispatchInspection(owners, [admitted], { target: 'https://github.com/owner/repo/pull/3' })
        .records.length,
      0,
    );
    assert.equal(
      dispatchInspection(owners, [admitted], { target: 'https://github.com/owner/repo/pull/7' })
        .records.length,
      3,
    );
    assert.equal(
      dispatchInspection(owners, [admitted], { id: owners[1]!.id, target: 'owner/repo#3' })
        .records[0]!.id,
      owners[1]!.id,
    );
    assert.equal(
      dispatchInspection(owners, [admitted], { id: owners[1]!.id, target: 'owner/repo#7' }).records
        .length,
      0,
    );
    assert.throws(
      () => dispatchInspection(records, [admitted], { target: '3' }),
      /qualified-target-required/,
    );
  });
  it('should page retained owners while preserving the unfiltered inspection contract', () => {
    const { admitted, records } = fixture();
    const before = structuredClone(records);
    const legacy = dispatchInspection(records, [admitted], {});
    assert.deepEqual(legacy.records, records);
    assert.equal(legacy.summary, false);
    assert.equal(legacy.nextOffset, undefined);
    const first = dispatchInspection(records, [admitted], { limit: 2 });
    assert.equal(first.summary, true);
    assert.equal(first.total, 3);
    assert.equal(first.nextOffset, 2);
    const second = dispatchInspection(records, [admitted], { limit: 2, offset: first.nextOffset });
    assert.deepEqual([...first.records, ...second.records], records);
    assert.equal(second.nextOffset, undefined);
    assert.deepEqual(records, before);
  });
  it('should expose progress and stalls without copying provider payloads into summaries', () => {
    const record = {
      ...fixture().records[0]!,
      feedback: {
        baseline: { issue: { large: 'x'.repeat(64_000) } },
        events: [],
        scannedTime: baseline,
        discoveryPending: true,
        code: 'feedback-discovery-no-progress',
        discoveryStalls: { issue: { operation: 'source-comments', attempts: 3 } },
        discovery: { issue: { since: baseline, startedAt: baseline, reads: {} } },
      },
    };
    const summary = dispatchInspectionSummary(record);
    assert.equal(summary.lifecycleCheckedAt, baseline);
    assert.equal(summary.feedback?.scannedTime, baseline);
    assert.equal(summary.feedback?.discoveryPending, true);
    assert.deepEqual(summary.feedback?.discoveryStalls, record.feedback.discoveryStalls);
    assert.equal(summary.feedback?.checkpoints, 1);
    assert.equal(summary.feedback?.code, record.feedback.code);
    assert.ok(JSON.stringify(summary).length < 2000);
  });
});
