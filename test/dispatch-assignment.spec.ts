import assert from 'node:assert/strict';
import {
  inspectActiveIssue,
  inspectAdmittedIssue,
  inspectContinuedIssue,
} from '../agent/dispatch-assignment.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { intakeFixture, removeFixtureAssignment } from './github-intake-fixture.ts';

describe('agent/dispatch-assignment', () => {
  const cases: [string, (fixture: ReturnType<typeof intakeFixture>) => void][] = [
    [
      'dispatch-receiver-account-changed',
      (f) => {
        Object.assign(f.client, { identity: { ...f.client.identity, nodeId: 'other' } });
      },
    ],
    [
      'dispatch-repository-identity-changed',
      (f) => {
        f.repository.nodeId = 'other';
      },
    ],
    [
      'dispatch-issue-identity-changed',
      (f) => {
        f.item.nodeId = 'other';
      },
    ],
    [
      'dispatch-issue-identity-changed',
      (f) => {
        Object.assign(f.item, { itemType: 'pull-request' });
      },
    ],
    [
      'dispatch-issue-closed',
      (f) => {
        f.item.state = 'closed';
      },
    ],
    [
      'dispatch-assignment-removed',
      (f) => {
        f.item.assignees = [];
      },
    ],
    [
      'dispatch-assignment-event-missing',
      (f) => {
        f.events.length = 0;
      },
    ],
  ];
  for (const [code, change] of cases)
    it(`should identify ${code}`, async () => {
      const f = intakeFixture();
      const record = structuredClone({
        receiving: f.client.identity,
        repository: f.repository,
        issue: f.item,
        assignment: f.events[0],
      }) as unknown as IntakeRecord;
      change(f);
      await assert.rejects(inspectAdmittedIssue(record, f.client), { message: code });
    });
  it('should continue an active task independently of admission defaults and assignment history', async () => {
    const f = intakeFixture();
    const record = structuredClone({
      receiving: f.client.identity,
      repository: f.repository,
      issue: f.item,
      assignment: f.events[0],
    }) as unknown as IntakeRecord;
    f.policy.allowedRepositoryOwners = [];
    f.policy.issueAssignment!.allowed = [];
    f.events.length = 0;
    f.repository.archived = true;
    assert.equal(
      (await inspectActiveIssue(record, f.client)).repo.nodeId,
      record.repository.nodeId,
    );
  });
  for (const [code, change] of cases.filter(([code]) =>
    [
      'dispatch-receiver-account-changed',
      'dispatch-repository-identity-changed',
      'dispatch-issue-identity-changed',
      'dispatch-issue-closed',
      'dispatch-assignment-removed',
    ].includes(code),
  ))
    it(`should retain ${code} as an active-task boundary`, async () => {
      const f = intakeFixture();
      const record = structuredClone({
        receiving: f.client.identity,
        repository: f.repository,
        issue: f.item,
        assignment: f.events[0],
      }) as unknown as IntakeRecord;
      change(f);
      await assert.rejects(inspectActiveIssue(record, f.client), { message: code });
    });
});

describe('agent/continued assignment authority', () => {
  for (const scenario of [
    'approved',
    'unapproved',
    'node-mismatch',
    'login-mismatch',
    'unavailable',
    'truncated',
    'conflicting',
    'older',
    'malformed',
    'other-assignee',
  ] as const) {
    it(`should preserve prior work unless removal is verified and approved: ${scenario}`, async () => {
      const f = intakeFixture();
      const intake = structuredClone({
        receiving: f.client.identity,
        repository: f.repository,
        issue: f.item,
        assignment: f.events[0],
      }) as unknown as IntakeRecord;
      const event = removeFixtureAssignment(f);
      if (scenario === 'unapproved')
        event.actor = { login: 'outsider', nodeId: 'U_outsider', type: 'User' };
      if (scenario === 'node-mismatch') event.actor = { ...event.actor, nodeId: 'different' };
      if (scenario === 'login-mismatch') event.actor = { ...event.actor, login: 'different' };
      if (scenario === 'unavailable')
        f.client.listAssignmentEvents = async () => {
          throw new Error('provider-unavailable');
        };
      if (scenario === 'truncated')
        f.client.listAssignmentEvents = async () => ({ events: f.events, truncated: true });
      if (scenario === 'conflicting') event.event = 'assigned' as 'unassigned';
      if (scenario === 'older') event.createdAt = '2026-10-07T09:00:00Z';
      if (scenario === 'malformed') event.createdAt = 'not-a-time';
      if (scenario === 'other-assignee')
        event.assignee = { ...event.assignee, nodeId: 'other', login: 'other' };
      if (scenario === 'approved') {
        event.actor = { ...event.actor, login: event.actor.login.toUpperCase() };
        await assert.rejects(
          inspectContinuedIssue(intake, f.client, f.policy.issueAssignment!.allowed),
          /dispatch-assignment-removed/,
        );
      } else {
        const current = await inspectContinuedIssue(
          intake,
          f.client,
          f.policy.issueAssignment!.allowed,
        );
        assert.equal(current.assignmentObservation?.missing, true);
        assert.notEqual(current.assignmentObservation?.code, 'assignment-removal-approved');
        assert.deepEqual(current.item.assignees, []);
      }
      await assert.rejects(inspectAdmittedIssue(intake, f.client), /dispatch-assignment-removed/);
    });
  }
  it('should order same-second events by database identity and ignore other assignees', async () => {
    const f = intakeFixture();
    const intake = structuredClone({
      receiving: f.client.identity,
      repository: f.repository,
      issue: f.item,
      assignment: f.events[0],
    }) as unknown as IntakeRecord;
    const removed = removeFixtureAssignment(f);
    f.events.push({ ...removed, databaseId: 32, nodeId: 'new-assignment', event: 'assigned' });
    assert.equal(
      (await inspectContinuedIssue(intake, f.client, f.policy.issueAssignment!.allowed))
        .assignmentObservation?.code,
      'assignment-removal-evidence-conflicting',
    );
    f.events.push({ ...removed, databaseId: 33, nodeId: 'new-removal' });
    f.events.push({
      ...removed,
      databaseId: 34,
      nodeId: 'other',
      event: 'assigned',
      assignee: { login: 'other', nodeId: 'U_other', type: 'User' },
    });
    f.events.reverse();
    await assert.rejects(
      inspectContinuedIssue(intake, f.client, f.policy.issueAssignment!.allowed),
      /dispatch-assignment-removed/,
    );
    f.policy.issueAssignment!.allowed = [];
    assert.equal(
      (await inspectContinuedIssue(intake, f.client, [])).assignmentObservation?.code,
      'assignment-removal-unapproved',
    );
    f.item.assignees = [f.client.identity];
    assert.equal(
      (await inspectContinuedIssue(intake, f.client, [])).assignmentObservation,
      undefined,
    );
  });
});
