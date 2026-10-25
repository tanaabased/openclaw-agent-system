import commentProviderFixture from './github-comment-provider-fixture.ts';
import reactivateAssignmentFeedback from '../agent/assignment-feedback-reactivation.ts';
import type { FeedbackSourceState } from '../agent/feedback-state.ts';
import { parseInstallationConfig, type InstallationConfig } from '../core/installation-config.ts';
import assert from 'node:assert/strict';
import assignmentRetirement from '../agent/assignment-retirement.ts';
import reconcile from '../agent/reconcile-assignment-lifecycle.ts';
import pendingAssignments, { issueKey } from '../agent/dispatch-pending.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import type { IntakeRecord, IntakeState } from '../channels/github/intake/record-store.ts';
import {
  intakeFixture,
  account,
  baseline,
  removeFixtureAssignment,
} from './github-intake-fixture.ts';

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
  const closedInputs: boolean[] = [];
  let archived = false;
  let idle = true;
  let activityId = 'turn-1';
  let failure = false;
  let beforeRecheck = () => {};
  const settings: { value: InstallationConfig } = {
    value: parseInstallationConfig(undefined, '/installation/config.yaml'),
  };
  const records = [record];
  const admissions = [admitted];
  const run = (
    targetId?: string,
    reactivate?: (record: SharedDispatchRecord, intake: IntakeRecord) => Promise<boolean>,
  ) =>
    reconcile({
      reactivate,
      configuration: settings.value,
      readConfiguration: async () => settings.value,
      records,
      admitted: admissions,
      policy: {
        policy: fixture.policy,
        username: 'receiver',
        digest: 'digest',
      },
      client: fixture.client,
      owner: 'intake',
      targetId,
      now,
      save: async () => {},
      fresh: async () => {},
      observe: async () => {
        if (failure) throw new Error('native-unavailable');
        return { archived, idle, activityId };
      },
      cleanup: async (_record, _admitted, fresh, _shared, _native, issueClosed) => {
        closedInputs.push(issueClosed);
        beforeRecheck();
        await fresh();
        cleanups++;
        return { archived: true, worktreeRemoved: true };
      },
    });
  return {
    fixture,
    settings,
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
    closedInputs,
    beforeRecheck: (callback: () => void) => {
      beforeRecheck = callback;
    },
  };
}

describe('assignment retirement', () => {
  for (const scenario of ['bot', 'malformed', 'human', 'busy'] as const) {
    it(`should preserve retirement safeguards with ${scenario} feedback on the linked pull request`, async () => {
      const h = setup();
      h.record.retirement = assignmentRetirement({
        reason: 'operator-requested',
        intakeId: h.admitted.id,
        now: baseline,
        operatorRequest: {
          caller: 'operator',
          turnId: 'turn',
          targetId: h.record.id,
          at: baseline,
        },
      });
      h.fixture.policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
      if (scenario === 'busy') h.setBusy(true);
      const getItem = h.fixture.client.getItem;
      h.fixture.client.getItem = async (owner, name, number) =>
        number === 45
          ? {
              ...h.fixture.item,
              itemType: 'pull-request',
              number,
              nodeId: 'PR_delivery',
              pullRequest: {
                baseRef: 'main',
                baseRepositoryDatabaseId: 10,
                baseRepositoryNodeId: 'R_repo',
                draft: false,
                headRef: 'branch',
                headSha: 'a'.repeat(40),
                merged: false,
              },
            }
          : getItem(owner, name, number);
      const raw = {
        nodeId: 'IC_bot',
        databaseId: 41,
        author: {
          login: scenario === 'malformed' ? 'bad/private-login' : 'netlify[bot]',
          nodeId: 'BOT_netlify',
          type: 'Bot',
        },
        body: '@receiver explain this',
        bodyLength: 22,
        createdAt: new Date(baseline + 68000).toISOString(),
        updatedAt: new Date(baseline + 68000).toISOString(),
      };
      const comments = commentProviderFixture((number) =>
        number === 45
          ? [
              raw,
              ...(scenario === 'human'
                ? [{ ...raw, nodeId: 'IC_human', databaseId: 42, author: account }]
                : []),
            ]
          : [],
      );
      const reactivate = (record: SharedDispatchRecord, intake: IntakeRecord) =>
        reactivateAssignmentFeedback({
          record,
          intake,
          policy: { policy: h.fixture.policy, username: 'receiver', digest: 'digest' },
          client: h.fixture.client,
          comments: async () => comments,
          pullRequest: { number: 45, nodeId: 'PR_delivery' },
          now: baseline + 70000,
          save: async () => {},
        });
      await h.run(h.record.id, reactivate);
      assert.equal(h.cleanups(), scenario === 'bot' ? 1 : 0);
      assert.equal(Boolean(h.record.retired), scenario === 'bot');
      const feedback = (h.record as SharedDispatchRecord & { feedback?: FeedbackSourceState })
        .feedback;
      assert.deepEqual(
        feedback?.events.map((event) => event.sourceId),
        scenario === 'human' ? ['IC_human'] : [],
      );
      assert.equal(Boolean(h.record.feedbackReactivation), scenario === 'human');
      if (scenario === 'human') assert.equal(h.record.retirement, undefined);
      else
        assert.equal(
          h.record.retirement?.code,
          scenario === 'malformed'
            ? 'github-response-invalid-issue-comment-author-login'
            : scenario === 'busy'
              ? 'retirement-native-work-unresolved'
              : undefined,
        );
      assert.equal(JSON.stringify(h.record.retirement ?? {}).includes('bad/private-login'), false);
    });
  }

  it('should retire one open assigned task immediately without changing scheduled peers', async () => {
    const h = setup();
    h.record.retirement = assignmentRetirement({
      reason: 'operator-requested',
      intakeId: h.admitted.id,
      now: baseline,
      operatorRequest: { caller: 'operator', turnId: 'turn', targetId: h.record.id, at: baseline },
    });
    h.record.lifecycleCheckedAt = baseline;
    h.records.push({ ...h.record, id: 'peer', retirement: undefined });
    await h.run(h.record.id);
    assert.equal(h.cleanups(), 1);
    assert.ok(h.record.retired);
    assert.equal(h.record.retirement?.reason, 'operator-requested');
    assert.equal(h.records[1]!.retirement, undefined);
    assert.equal(h.fixture.item.state, 'open');
    await h.run(h.record.id);
    assert.equal(h.cleanups(), 1);
  });

  it('should fence admissions at the operator request rather than an older cleanup observation', async () => {
    const h = setup();
    h.record.retirement = assignmentRetirement({
      previous: assignmentRetirement({
        reason: 'issue-closed',
        intakeId: h.admitted.id,
        now: baseline - 60000,
        graceMinutes: 60,
      }),
      reason: 'operator-requested',
      intakeId: h.admitted.id,
      now: baseline,
      operatorRequest: { caller: 'operator', turnId: 'turn', targetId: h.record.id, at: baseline },
    });
    const successor = {
      ...h.admitted,
      id: 'successor',
      assignment: { ...h.admitted.assignment, createdAt: new Date(baseline - 30000).toISOString() },
    };
    h.admissions.push(successor);
    await h.run(h.record.id);
    assert.ok(h.record.retired);
    assert.equal(h.record.retirement!.at, baseline - 60000);
    const intake = { records: h.admissions } as IntakeState;
    assert.deepEqual(pendingAssignments({ records: h.records }, intake), []);
    const fresh = {
      ...successor,
      id: 'fresh',
      assignment: { ...successor.assignment, createdAt: new Date(baseline + 1).toISOString() },
    };
    h.admissions.push(fresh);
    assert.deepEqual(pendingAssignments({ records: h.records }, intake), [
      { intake: fresh, record: undefined },
    ]);
  });

  it('should retain manual intent through activity and idle transitions without restarting grace', async () => {
    const h = setup();
    h.record.retirement = assignmentRetirement({
      reason: 'operator-requested',
      intakeId: h.admitted.id,
      now: baseline,
      operatorRequest: { caller: 'operator', turnId: 'turn', targetId: h.record.id, at: baseline },
    });
    h.setBusy(true);
    await h.run(h.record.id);
    assert.equal(h.cleanups(), 0);
    assert.equal(h.record.retirement?.code, 'retirement-native-work-unresolved');
    h.advance(1);
    h.activity();
    h.setBusy(false);
    await h.run();
    assert.equal(h.cleanups(), 1);
    assert.equal(h.record.retirement?.eligibleAt, baseline);
  });

  it('should preserve a manual request while current cleanup configuration blocks effects', async () => {
    const h = setup();
    h.record.retirement = assignmentRetirement({
      reason: 'operator-requested',
      intakeId: h.admitted.id,
      now: baseline,
      operatorRequest: { caller: 'operator', turnId: 'turn', targetId: h.record.id, at: baseline },
    });
    h.settings.value = {
      status: 'blocked',
      code: 'retirement-configuration-invalid',
      path: '/installation/config.yaml',
    };
    await h.run(h.record.id);
    assert.equal(h.cleanups(), 0);
    assert.equal(h.record.retirement?.code, 'retirement-configuration-invalid');
    h.settings.value = parseInstallationConfig(undefined, '/installation/config.yaml');
    await h.run(h.record.id);
    assert.ok(h.record.retired);
  });

  for (const shared of [false, true]) {
    it(`should ${shared ? 'block' : 'complete'} unavailable-session retirement ${shared ? 'with' : 'without'} an active shared owner`, async () => {
      const h = setup();
      h.record.worktree = '/managed/issue';
      h.fixture.item.state = 'closed';
      h.settings.value = parseInstallationConfig(
        'schema-version: 1\ncleanup: {grace-minutes: 0}',
        '/installation/config.yaml',
      );
      if (shared)
        h.records.push({ ...h.record, id: 'active-peer', sourceThreadId: 'different-owner' });
      let removals = 0;
      await reconcile({
        configuration: h.settings.value,
        readConfiguration: async () => h.settings.value,
        records: h.records,
        admitted: h.admissions,
        policy: {
          policy: h.fixture.policy,
          username: 'receiver',
          digest: 'digest',
        },
        client: h.fixture.client,
        owner: 'intake',
        now: baseline,
        save: async () => {},
        fresh: async () => {},
        observe: async () => ({ archived: false, idle: false, unavailableSession: 'not-found' }),
        cleanup: async (_record, _intake, recheck) => {
          await recheck();
          removals++;
          return { archived: false, unavailableSession: 'not-found', worktreeRemoved: true };
        },
      });
      assert.equal(removals, shared ? 0 : 1);
      assert.equal(Boolean(h.record.retired), !shared);
      assert.equal(h.record.retirement?.archivedAt, undefined);
      assert.equal(h.record.nativeInactive, undefined);
      assert.deepEqual(h.record.retirement?.sessionUnavailableObserved, {
        at: baseline,
        session: 'not-found',
      });
      if (shared) assert.equal(h.record.retirement?.code, 'retirement-worktree-shared');
    });
  }
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
  for (const scenario of ['unapproved', 'unavailable', 'legacy'] as const) {
    it(`should preserve resources and membership under unresolved removal: ${scenario}`, async () => {
      const h = setup();
      const event = removeFixtureAssignment(h.fixture);
      if (scenario !== 'unavailable') event.actor = { ...account, nodeId: 'outsider' };
      else
        h.fixture.client.listAssignmentEvents = async () => {
          throw new Error('unavailable');
        };
      if (scenario === 'legacy')
        h.record.retirement = assignmentRetirement({
          reason: 'assignment-removed',
          intakeId: h.admitted.id,
          now: baseline,
          graceMinutes: 0,
        });
      h.settings.value = {
        status: 'blocked',
        code: 'retirement-configuration-invalid',
        path: '/installation/config.yaml',
      };
      await h.run();
      h.advance(120);
      await h.run();
      assert.equal(h.record.retirement, undefined);
      assert.equal(h.record.retired, undefined);
      assert.equal(h.record.assignmentObservation?.missing, true);
      assert.equal(h.cleanups(), 0);
    });
  }
  it('should revalidate the live actor list immediately before destructive cleanup', async () => {
    const h = setup();
    removeFixtureAssignment(h.fixture);
    await h.run();
    assert.equal(h.record.retirement?.reason, 'assignment-removed');
    h.advance(60);
    h.beforeRecheck(() => {
      h.fixture.policy.issueAssignment!.allowed = [];
    });
    await h.run();
    assert.equal(h.cleanups(), 0);
    assert.equal(h.record.retired, undefined);
    h.advance(1);
    await h.run();
    assert.equal(h.record.retirement, undefined);
    assert.equal(h.record.assignmentObservation?.code, 'assignment-removal-unapproved');
  });
  it('should restart removal grace after newer evidence invalidates an earlier cleanup decision', async () => {
    const h = setup();
    const event = removeFixtureAssignment(h.fixture);
    await h.run();
    h.advance(60);
    h.beforeRecheck(() => {
      h.fixture.events.push({ ...event, nodeId: 'E_later_removal', databaseId: 33 });
    });
    await h.run();
    assert.equal(h.cleanups(), 0);
    h.beforeRecheck(() => {});
    h.advance(1);
    await h.run();
    assert.equal(h.record.retirement?.removalEventId, 'E_later_removal');
    assert.equal(h.record.retirement?.eligibleAt, baseline + 121 * 60_000);
    assert.equal(h.cleanups(), 0);
  });
  it('should resolve missing assignment authority through the current approved actor list', async () => {
    const h = setup();
    const event = removeFixtureAssignment(h.fixture);
    event.actor = { ...account, nodeId: 'U_other', login: 'other' };
    await h.run();
    assert.equal(Boolean(h.record.retirement), false);
    h.fixture.policy.issueAssignment!.allowed = [event.actor];
    h.advance(1);
    await h.run();
    assert.equal(h.record.assignmentObservation?.code, 'assignment-removal-approved');
    assert.equal(h.record.retirement?.reason, 'assignment-removed');
  });
  it('should retain uncertain native effects when legacy removal authority cannot be verified', async () => {
    const h = setup();
    removeFixtureAssignment(h.fixture);
    h.fixture.policy.issueAssignment!.allowed = [];
    h.record.retirement = assignmentRetirement({
      reason: 'assignment-removed',
      intakeId: h.admitted.id,
      now: baseline,
      graceMinutes: 0,
    });
    h.record.retirement!.archiveAttempt = { at: baseline, turnId: 'archive-turn' };
    await h.run();
    assert.equal(h.record.retirement?.archiveAttempt?.turnId, 'archive-turn');
    assert.equal(h.record.retirement?.code, 'retirement-removal-authority-unresolved');
    assert.equal(h.cleanups(), 0);
  });
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
    removeFixtureAssignment(h.fixture);
    await h.run();
    assert.equal(h.record.retirement?.reason, 'assignment-removed');
    h.fixture.item.assignees = [account];
    const event = {
      ...h.fixture.events[0]!,
      nodeId: 'new-event',
      event: 'assigned' as const,
      databaseId: 32,
      createdAt: new Date(baseline + 180_000).toISOString(),
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
  it('should restore an admitted reassignment after its assigner leaves the allowlist', async () => {
    const h = setup();
    removeFixtureAssignment(h.fixture);
    await h.run();
    const event = {
      ...h.fixture.events[0]!,
      nodeId: 'reassigned',
      event: 'assigned' as const,
      databaseId: 32,
      createdAt: new Date(baseline + 180_000).toISOString(),
    };
    h.fixture.item.assignees = [account];
    h.fixture.events.push(event);
    h.admissions.push({ ...h.admitted, id: 'successor', assignment: event });
    h.fixture.policy.issueAssignment!.allowed = [];
    h.fixture.policy.allowedRepositoryOwners = [];
    h.advance(1);
    await h.run();
    assert.equal(h.record.retirement, undefined);
    assert.equal(h.record.intakeId, 'successor');
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
  it('should hold invalid cleanup settings without falsely reporting retirement', async () => {
    const h = setup();
    h.settings.value = {
      status: 'blocked',
      code: 'retirement-configuration-invalid',
      path: '/installation/config.yaml',
    };
    h.fixture.item.state = 'closed';
    await h.run();
    h.advance(30);
    await h.run();
    assert.equal(h.record.retired, undefined);
    assert.equal(h.record.retirement?.code, 'retirement-configuration-invalid');
    assert.equal(h.cleanups(), 0);
  });
  it('should begin a full shared grace only after invalid configuration is repaired', async () => {
    const h = setup();
    h.settings.value = {
      status: 'blocked',
      code: 'retirement-configuration-invalid',
      path: '/installation/config.yaml',
    };
    h.fixture.item.state = 'closed';
    await h.run();
    h.advance(120);
    await h.run();
    assert.equal(h.record.retirement?.deadlinePending, true);
    h.settings.value = parseInstallationConfig(
      'schema-version: 1\ncleanup: {grace-minutes: 17}',
      '/installation/config.yaml',
    );
    h.advance(1);
    await h.run();
    assert.equal(h.record.retirement?.eligibleAt, baseline + 138 * 60_000);
    assert.equal(h.cleanups(), 0);
    h.advance(17);
    await h.run();
    assert.equal(h.cleanups(), 1);
    assert.ok(h.record.retired);
  });

  it('should preserve an existing deadline through a configuration hold and grace edits', async () => {
    const h = setup();
    h.fixture.item.state = 'closed';
    await h.run();
    const deadline = h.record.retirement!.eligibleAt;
    h.settings.value = { status: 'blocked', code: 'retirement-configuration-invalid' };
    h.advance(60);
    await h.run();
    assert.equal(h.record.retirement?.eligibleAt, deadline);
    assert.equal(h.record.retirement?.code, 'retirement-configuration-invalid');
    assert.equal(h.cleanups(), 0);
    h.settings.value = parseInstallationConfig(
      'schema-version: 1\ncleanup: {grace-minutes: 43200}',
      '/installation/config.yaml',
    );
    h.advance(1);
    await h.run();
    assert.equal(h.record.retirement?.eligibleAt, deadline);
    assert.equal(h.cleanups(), 1);
  });

  it('should defer a resource effect when settings change at its final recheck', async () => {
    const h = setup();
    h.fixture.item.state = 'closed';
    await h.run();
    h.advance(60);
    h.beforeRecheck(() => {
      h.settings.value = parseInstallationConfig(
        'schema-version: 1\ncleanup: {grace-minutes: 0}',
        '/installation/config.yaml',
      );
    });
    await h.run();
    assert.equal(h.cleanups(), 0);
    assert.equal(h.record.retirement?.code, 'retirement-configuration-changed');
    h.advance(1);
    await h.run();
    assert.equal(h.cleanups(), 1);
  });

  it('should preserve historically retired resources without enqueueing a cleanup sweep', async () => {
    const h = setup();
    h.record.retired = { at: baseline, by: 'intake' };
    h.fixture.item.state = 'closed';
    h.advance(120);
    await h.run();
    assert.equal(h.cleanups(), 0);
    assert.equal(h.record.retirement, undefined);
    assert.deepEqual(h.record.retired, { at: baseline, by: 'intake' });
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
      other.retirement = {
        ...h.record.retirement!,
        archivedAt: baseline + 3_600_000,
        worktreeRemovedAt: baseline + 3_600_000,
      };
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
        configuration: h.settings.value,
        readConfiguration: async () => h.settings.value,
        records: h.records,
        admitted: h.admissions,
        policy: {
          policy: h.fixture.policy,
          username: 'receiver',
          digest: 'digest',
        },
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
  for (const condition of [
    'busy',
    'unknown',
    'grace',
    'reactivated',
    'pending-deadline',
    'legacy',
  ] as const) {
    it(`should keep a shared checkout when a pending peer is ${condition}`, async () => {
      const h = setup();
      h.fixture.item.state = 'closed';
      h.record.worktree = '/managed/shared';
      await h.run();
      const other = { ...structuredClone(h.record), id: 'second' };
      if (condition === 'grace') other.retirement!.eligibleAt += 60_000;
      if (condition === 'pending-deadline') other.retirement!.deadlinePending = true;
      if (condition === 'legacy') other.retired = { at: baseline, by: 'old-owner' };
      h.records.push(other);
      let cleanups = 0;
      await reconcile({
        configuration: h.settings.value,
        readConfiguration: async () => h.settings.value,
        records: h.records,
        admitted: h.admissions,
        policy: {
          policy: h.fixture.policy,
          username: 'receiver',
          digest: 'digest',
        },
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
      assert.ok(
        h.records
          .filter((record) => condition !== 'legacy' || record.id !== 'second')
          .every((record) => !record.retired),
      );
    });
  }
  it('should retain observation of busy work while cleanup configuration is invalid', async () => {
    const h = setup();
    h.settings.value = {
      status: 'blocked',
      code: 'retirement-configuration-invalid',
      path: '/installation/config.yaml',
    };
    removeFixtureAssignment(h.fixture);
    h.setBusy(true);
    await h.run();
    assert.equal(Boolean(h.record.retired), false);
    h.setBusy(false);
    h.advance(1);
    await h.run();
    assert.equal(h.record.retired, undefined);
    assert.equal(h.record.retirement?.code, 'retirement-configuration-invalid');
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
  for (const closed of [false, true]) {
    it(`should pass fresh closure rather than the archived chat reason when closed is ${closed}`, async () => {
      const h = setup();
      h.setArchived();
      h.fixture.item.state = closed ? 'closed' : 'open';
      await h.run();
      h.advance(60);
      await h.run();
      assert.equal(h.record.retirement?.reason, 'chat-archived');
      assert.deepEqual(h.closedInputs, [closed]);
      assert.equal(h.cleanups(), 1);
    });
  }
  it('should stop closed-issue disposal when an archived issue reopens at the effect recheck', async () => {
    const h = setup();
    h.fixture.item.state = 'closed';
    h.setArchived();
    await h.run();
    h.advance(60);
    h.beforeRecheck(() => {
      h.fixture.item.state = 'open';
    });
    await h.run();
    assert.deepEqual(h.closedInputs, [true]);
    assert.equal(h.cleanups(), 0);
    assert.equal(h.record.retired, undefined);
    assert.equal(h.record.retirement?.code, 'retirement-observation-changed');
  });
});
