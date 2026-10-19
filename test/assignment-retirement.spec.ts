import assert from 'node:assert/strict';
import assignmentRetirement from '../agent/assignment-retirement.ts';
import reconcile from '../agent/reconcile-assignment-lifecycle.ts';
import pendingAssignments, { issueKey } from '../agent/dispatch-pending.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import type { IntakeRecord, IntakeState } from '../channels/github/intake/record-store.ts';
import { intakeFixture, account, baseline } from './github-intake-fixture.ts';

function setup() {
  const fixture = intakeFixture();
  const admitted: IntakeRecord = {
    id: 'admitted',
    scope: 'scope',
    receiving: account,
    repository: fixture.repository,
    issue: fixture.item,
    assignment: fixture.events[0]!,
  } as unknown as IntakeRecord;
  const record: SharedDispatchRecord = {
    id: 'record',
    intakeId: admitted.id,
    issueKey: issueKey(admitted),
    sourceThreadId: 'intake',
    phase: 'routing',
    createdAt: baseline,
    manifestDigest: 'manifest',
    request: {},
  };
  let now = baseline;
  let cleanups = 0;
  let archived = false;
  let idle = true;
  let activityId = 'turn-1';
  let failure = false;
  const records = [record];
  const admissions = [admitted];
  const run = () =>
    reconcile({
      records,
      admitted: admissions,
      policy: { policy: fixture.policy, username: 'receiver', digest: 'digest' },
      client: fixture.client,
      owner: 'intake',
      now,
      save: async () => {},
      fresh: async () => {},
      observe: async () => {
        if (failure) throw new Error('native-unavailable');
        return { archived, idle, activityId };
      },
      cleanup: async (_record, _admitted, fresh) => {
        await fresh();
        cleanups++;
        return { archived: true, worktreeRemoved: true };
      },
    });
  return {
    fixture,
    record,
    admitted,
    records,
    admissions,
    run,
    advance: (minutes: number) => {
      now += minutes * 60_000;
    },
    setArchived: () => {
      archived = true;
    },
    setBusy: (value: boolean) => {
      idle = !value;
    },
    activity: () => {
      activityId = 'turn-2';
    },
    fail: () => {
      failure = true;
    },
    cleanups: () => cleanups,
  };
}

describe('assignment retirement', () => {
  for (const reason of ['issue-closed', 'assignment-removed', 'chat-archived'] as const) {
    it(`should preserve the ${reason} deadline across repeated observations and restart`, () => {
      const first = assignmentRetirement({
        reason,
        intakeId: 'event',
        now: 100,
        graceMinutes: 60,
        activityId: 'turn',
      })!;
      const next = assignmentRetirement({
        previous: JSON.parse(JSON.stringify(first)),
        reason,
        intakeId: 'event',
        now: 600_100,
        graceMinutes: 60,
        activityId: 'turn',
      })!;
      assert.equal(next.at, 100);
      assert.equal(next.eligibleAt, 3_600_100);
      assert.equal(next.checkedAt, 600_100);
    });
  }
  it('should retire closure after the grace period, without using the old issue timestamp', async () => {
    const h = setup();
    h.fixture.item.state = 'closed';
    await h.run();
    assert.equal(h.record.retirement?.at, baseline);
    assert.equal(Boolean(h.record.retired), false);
    assert.equal(h.cleanups(), 0);
    h.advance(59);
    await h.run();
    assert.equal(h.cleanups(), 0);
    h.advance(1);
    await h.run();
    assert.equal(h.cleanups(), 1);
    assert.equal(h.record.retired?.at, baseline + 3_600_000);
    h.advance(60);
    await h.run();
    assert.equal(h.cleanups(), 1);
  });
  it('should treat unassignment as pending retirement and cancel it on verified reassignment', async () => {
    const h = setup();
    h.fixture.item.assignees = [];
    await h.run();
    assert.equal(h.record.retirement?.reason, 'assignment-removed');
    h.fixture.item.assignees = [account];
    const event = {
      ...h.fixture.events[0]!,
      nodeId: 'new-event',
      event: 'assigned' as const,
      databaseId: 31,
      createdAt: new Date(baseline + 60_000).toISOString(),
    };
    h.fixture.events.push(event);
    h.admissions.push({ ...h.admitted, id: 'successor', assignment: event });
    h.advance(1);
    await h.run();
    assert.equal(h.record.retirement, undefined);
    assert.equal(h.record.intakeId, 'successor');
    assert.equal(h.records.length, 1);
    assert.equal(h.cleanups(), 0);
  });
  it('should not retire when another assignee is added or a provider read is unavailable', async () => {
    const h = setup();
    h.fixture.item.assignees.push({ ...account, login: 'someone', nodeId: 'someone' });
    await h.run();
    assert.equal(h.record.retirement, undefined);
    h.fixture.client.getItem = async () => {
      throw new Error('provider-unavailable');
    };
    h.advance(60);
    await h.run();
    assert.equal(h.record.retirement, undefined);
    assert.equal(h.cleanups(), 0);
  });
  it('should stop obsolete membership even when native observation fails', async () => {
    const h = setup();
    h.fixture.item.state = 'closed';
    h.fail();
    await h.run();
    assert.equal(h.record.retirement?.reason, 'issue-closed');
    assert.equal(h.record.retirement?.code, 'native-unavailable');
    assert.equal(h.cleanups(), 0);
  });
  it('should retain capacity evidence and defer cleanup while execution remains active', async () => {
    const h = setup();
    h.fixture.item.state = 'closed';
    h.setBusy(true);
    await h.run();
    h.advance(60);
    await h.run();
    assert.equal(h.record.nativeInactive, false);
    assert.equal(h.cleanups(), 0);
    h.setBusy(false);
    h.advance(1);
    await h.run();
    assert.equal(h.cleanups(), 0);
    h.advance(60);
    await h.run();
    assert.equal(h.cleanups(), 1);
  });
  it('should postpone cleanup for a new native turn without restarting it for polls', async () => {
    const h = setup();
    h.fixture.item.state = 'closed';
    await h.run();
    h.advance(30);
    h.activity();
    await h.run();
    assert.equal(h.record.retirement?.eligibleAt, baseline + 90 * 60_000);
    h.advance(30);
    await h.run();
    assert.equal(h.cleanups(), 0);
    h.advance(30);
    await h.run();
    assert.equal(h.cleanups(), 1);
  });
  it('should use a configurable grace period and preserve resources when cleanup is disabled', async () => {
    const h = setup();
    h.fixture.policy.cleanup = { enabled: false, graceMinutes: 30 };
    h.fixture.item.state = 'closed';
    await h.run();
    h.advance(30);
    await h.run();
    assert.ok(h.record.retired);
    assert.equal(h.cleanups(), 0);
  });
  it('should suppress old admission while pending but admit fresh work after manual archival', async () => {
    const h = setup();
    h.setArchived();
    await h.run();
    const intake = { records: h.admissions } as IntakeState;
    assert.deepEqual(pendingAssignments({ records: h.records }, intake), []);
    const successor = { ...h.admitted, id: 'successor' };
    h.admissions.push(successor);
    assert.deepEqual(pendingAssignments({ records: h.records }, intake), [
      { intake: successor, record: undefined },
    ]);
  });
  for (const age of ['older', 'same-age', 'newer'] as const) {
    it(`should preserve a worktree shared with ${age} active work`, async () => {
      const h = setup();
      h.record.worktree = '/managed/issue';
      h.fixture.item.state = 'closed';
      await h.run();
      const other: SharedDispatchRecord = {
        ...h.record,
        id: 'other',
        sourceThreadId: 'other-intake',
        createdAt: baseline + (age === 'older' ? -1 : age === 'newer' ? 1 : 0),
        retirement: undefined,
        nativeInactive: false,
      };
      h.records.push(other);
      h.advance(60);
      await h.run();
      assert.equal(h.record.retirement?.code, 'retirement-worktree-shared');
      assert.equal(h.cleanups(), 0);
      assert.equal(h.record.retired, undefined);
      other.retired = { at: baseline + 3_600_000, by: 'other-intake' };
      other.nativeInactive = true;
      h.advance(1);
      await h.run();
      assert.equal(h.cleanups(), 1);
      assert.ok(h.record.retired);
    });
  }
  it('should archive eligible shared owners before reclaiming their checkout once', async () => {
    const h = setup();
    h.fixture.item.state = 'closed';
    h.record.worktree = '/managed/shared';
    h.records.push({ ...h.record, id: 'second' });
    const archived = new Set<string>();
    let removals = 0;
    let now = baseline;
    const run = () =>
      reconcile({
        records: h.records,
        admitted: h.admissions,
        policy: { policy: h.fixture.policy, username: 'receiver', digest: 'digest' },
        client: h.fixture.client,
        owner: 'intake',
        now,
        save: async () => {},
        fresh: async () => {},
        observe: async (record) => ({
          archived: archived.has(record.id),
          idle: true,
          activityId: 'turn',
        }),
        cleanup: async (record, _intake, fresh, shared) => {
          await fresh();
          archived.add(record.id);
          const removed = shared.every((other) => archived.has(other.id));
          if (removed && !removals) removals++;
          return { archived: true, worktreeRemoved: removed };
        },
      });
    await run();
    now += 3_600_000;
    await run();
    now += 60_000;
    await run();
    assert.equal(archived.size, 2);
    assert.equal(removals, 1);
    assert.ok(h.records.every((record) => record.retired));
  });
  for (const condition of ['busy', 'unknown', 'grace', 'reactivated'] as const) {
    it(`should keep a shared checkout when a pending peer is ${condition}`, async () => {
      const h = setup();
      h.fixture.item.state = 'closed';
      h.record.worktree = '/managed/shared';
      await h.run();
      const other = { ...structuredClone(h.record), id: 'second' };
      if (condition === 'grace') other.retirement!.eligibleAt += 60_000;
      h.records.push(other);
      let cleanups = 0;
      await reconcile({
        records: h.records,
        admitted: h.admissions,
        policy: { policy: h.fixture.policy, username: 'receiver', digest: 'digest' },
        client: h.fixture.client,
        owner: 'intake',
        now: baseline + 3_600_000,
        save: async () => {},
        fresh: async () => {},
        observe: async (record) =>
          record.id === 'second' && condition === 'unknown'
            ? undefined
            : {
                archived: false,
                idle: condition !== 'busy',
                activityId: condition === 'reactivated' ? 'new-turn' : 'turn-1',
              },
        cleanup: async () => {
          cleanups++;
          return { archived: true, worktreeRemoved: true };
        },
      });
      assert.equal(cleanups, 0);
      assert.ok(h.records.every((record) => !record.retired));
    });
  }
  it('should retain observation of busy work even when automatic cleanup is disabled', async () => {
    const h = setup();
    h.fixture.policy.cleanup = { enabled: false, graceMinutes: 60 };
    h.fixture.item.assignees = [];
    h.setBusy(true);
    await h.run();
    assert.equal(Boolean(h.record.retired), false);
    h.setBusy(false);
    h.advance(1);
    await h.run();
    assert.ok(h.record.retired);
    assert.equal(h.record.nativeInactive, true);
    assert.equal(h.cleanups(), 0);
  });
  it('should not clean up a reopened issue or silently restart the old assignment', async () => {
    const h = setup();
    h.fixture.item.state = 'closed';
    await h.run();
    h.fixture.item.state = 'open';
    h.advance(60);
    await h.run();
    assert.equal(h.cleanups(), 0);
    assert.equal(h.record.retirement?.code, 'retirement-awaiting-reactivation');
  });
});
