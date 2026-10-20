import assert from 'node:assert/strict';
import { inspectActiveIssue, inspectAdmittedIssue } from '../agent/dispatch-assignment.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { intakeFixture } from './github-intake-fixture.ts';

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
