import assert from 'node:assert/strict';
import revalidateAssignment from '../agent/dispatch-assignment.ts';
import { dispatchFailurePhase } from '../agent/dispatch-retry.ts';
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
      'dispatch-repository-archived',
      (f) => {
        f.repository.archived = true;
      },
    ],
    [
      'dispatch-repository-disabled',
      (f) => {
        f.repository.disabled = true;
      },
    ],
    [
      'dispatch-repository-owner-changed',
      (f) => {
        f.repository.owner = { login: 'other', nodeId: 'other', type: 'Organization' };
      },
    ],
    [
      'dispatch-repository-name-changed',
      (f) => {
        f.repository.name = 'other';
      },
    ],
    [
      'dispatch-repository-owner-not-allowed',
      (f) => {
        f.policy.allowedRepositoryOwners = [];
      },
    ],
    [
      'dispatch-issue-identity-changed',
      (f) => {
        f.item.nodeId = 'other';
      },
    ],
    [
      'dispatch-issue-type-changed',
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
    [
      'dispatch-assignment-actor-type-changed',
      (f) => {
        f.events[0]!.actor = { ...f.events[0]!.actor, type: 'Bot' };
      },
    ],
    [
      'dispatch-assignment-actor-not-allowed',
      (f) => {
        f.policy.issueAssignment!.allowed = [];
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
      await assert.rejects(
        revalidateAssignment(
          { policy: f.policy, username: 'receiver', digest: '' },
          record,
          f.client,
        ),
        { message: code },
      );
      assert.equal(
        dispatchFailurePhase({}, code),
        code === 'dispatch-assignment-event-missing' ? 'waiting' : 'blocked',
      );
    });
});
