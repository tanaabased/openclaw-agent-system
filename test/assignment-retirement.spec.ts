import commentProviderFixture from './github-comment-provider-fixture.ts';
import reactivateAssignmentFeedback from '../agent/assignment-feedback-reactivation.ts';
import type { FeedbackSourceState } from '../agent/feedback-state.ts';
import {
  parseCleanupConfiguration,
  type CleanupConfiguration,
} from '../agent/cleanup-configuration.ts';
import assert from 'node:assert/strict';
import assignmentRetirement from '../agent/assignment-retirement.ts';
import workflowStatus from '../agent/workflow-status.ts';
import reconcile from '../agent/reconcile-assignment-lifecycle.ts';
import pendingAssignments, { issueKey } from '../agent/dispatch-pending.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import type { OperatorIssue } from '../agent/managed-issue.ts';
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
  const settings: { value: CleanupConfiguration } = {
    value: parseCleanupConfiguration(),
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
  for (const scenario of ['cancelled', 'active', 'wrong-type', 'wrong-identity'] as const) {
    it(`should validate the recorded pull request during ${scenario} retirement`, async () => {
      const h = setup();
      const manual: OperatorIssue = {
        version: 1,
        host: 'github.com',
        id: h.admitted.id,
        scope: h.admitted.scope,
        receiving: h.admitted.receiving,
        repository: h.admitted.repository,
        issue: h.admitted.issue,
        workspaceDir: '/workspace',
        agentId: 'receiver',
        observedAt: baseline,
        admittedAt: baseline,
        status: 'admitted',
        requiresRevalidation: true,
        initiation: {
          kind: 'operator',
          session: 'operator',
          incarnation: 'session',
          turn: 'turn',
          input: 'input',
        },
        evidence: { policyDigest: 'digest', mode: 'work', open: true, repositoryReadable: true },
        pullRequest: {
          headRef: 'feature',
          baseRef: 'main',
          headSha: 'a'.repeat(40),
          repositoryNodeId: h.fixture.repository.nodeId,
          repositoryDatabaseId: h.fixture.repository.databaseId,
          authorId: account.nodeId,
        },
      };
      h.record.manualIssue = manual;
      delete h.record.intakeId;
      h.admissions.length = 0;
      if (scenario === 'cancelled') delete h.record.request;
      h.fixture.client.getItem = async () => ({
        ...h.fixture.item,
        nodeId: scenario === 'wrong-identity' ? 'PR_other' : manual.issue.nodeId,
        ...(scenario === 'wrong-type'
          ? { itemType: 'issue' as const }
          : {
              itemType: 'pull-request' as const,
              pullRequest: {
                merged: false,
                draft: true,
                headRef: 'feature',
                baseRef: 'main',
                headSha: 'a'.repeat(40),
                baseRepositoryNodeId: h.fixture.repository.nodeId,
                baseRepositoryDatabaseId: h.fixture.repository.databaseId,
              },
            }),
      });
      h.record.retirement = assignmentRetirement({
        reason: 'operator-requested',
        intakeId: manual.id,
        now: baseline,
        operatorRequest: {
          caller: 'operator',
          turnId: 'turn',
          targetId: h.record.id,
          at: baseline,
        },
      });
      await h.run(h.record.id);
      if (scenario.startsWith('wrong-')) {
        assert.equal(h.cleanups(), 0);
        assert.equal(h.record.retirement?.code, 'dispatch-issue-identity-changed');
        assert.equal(h.record.retired, undefined);
      } else {
        assert.equal(h.cleanups(), 1);
        assert.ok(h.record.retired);
        assert.equal(h.record.retirement?.code, undefined);
        assert.equal(h.fixture.item.state, 'open');
        await h.run(h.record.id);
        assert.equal(h.cleanups(), 1);
      }
    });
  }

  it('should retain open unassigned work past grace without attempting cleanup', async () => {
    const h = setup();
    removeFixtureAssignment(h.fixture);
    await h.run();
    h.advance(120);
    await h.run();
    assert.equal(h.cleanups(), 0);
    assert.equal(workflowStatus(h.record), 'awaiting-reassignment');
    assert.equal(h.record.nativeInactive, true);
    assert.equal(h.record.retired, undefined);
    assert.equal(h.records.length, 1);
  });
  for (const assigned of [false, true]) {
    it(`should start closure retirement after dormant removal with assignment ${assigned}`, async () => {
      const h = setup();
      removeFixtureAssignment(h.fixture);
      await h.run();
      h.advance(120);
      if (assigned) h.fixture.item.assignees = [account];
      h.fixture.item.state = 'closed';
      await h.run();
      assert.equal(h.cleanups(), 0);
      assert.equal(workflowStatus(h.record), 'retirement-pending');
      assert.equal(h.record.retirement?.at, baseline + 120 * 60_000);
      h.advance(60);
      await h.run();
      assert.equal(h.cleanups(), 1);
      assert.deepEqual(h.closedInputs, [true]);
      assert.ok(h.record.retired);
    });
  }
  for (const receipt of [
    { code: 'retirement-worktree-dirty' },
    { archiveAttempt: { at: baseline, turnId: 'archive-turn' } },
    { archiveRequest: { at: baseline, sessionId: 'original' } },
    { archivedAt: baseline },
    { worktreeRemovalAttemptedAt: baseline },
    { worktreeRemovedAt: baseline },
  ]) {
    it(`should retain legacy removal ${Object.keys(receipt)[0]!.toLowerCase()} evidence without replay`, async () => {
      const h = setup();
      removeFixtureAssignment(h.fixture);
      h.record.retirement = {
        ...assignmentRetirement({
          reason: 'assignment-removed',
          intakeId: h.admitted.id,
          now: baseline,
          graceMinutes: 0,
        })!,
        ...receipt,
      };
      await h.run();
      h.advance(120);
      await h.run();
      assert.equal(workflowStatus(h.record), 'awaiting-reassignment');
      for (const [key, value] of Object.entries(receipt))
        assert.deepEqual(h.record.retirement![key as keyof typeof h.record.retirement], value);
      assert.equal(h.record.retired, undefined);
      assert.equal(h.cleanups(), 0);
      assert.equal(pendingAssignments({ records: h.records }, { records: h.admissions }).length, 0);
      if (!('code' in receipt)) {
        const event = {
          ...h.fixture.events[0]!,
          nodeId: 'reassigned',
          databaseId: 40,
          event: 'assigned' as const,
          createdAt: new Date(baseline + 120 * 60_000).toISOString(),
        };
        h.fixture.item.assignees = [account];
        h.fixture.events.push(event);
        h.admissions.push({ ...h.admitted, id: 'successor', assignment: event });
        h.advance(1);
        let feedbackChecks = 0;
        await h.run(undefined, async () => {
          feedbackChecks++;
          return true;
        });
        assert.equal(feedbackChecks, 0);
        assert.equal(h.record.intakeId, h.admitted.id);
        assert.equal(workflowStatus(h.record), 'awaiting-reassignment');
        for (const [key, value] of Object.entries(receipt))
          assert.deepEqual(h.record.retirement![key as keyof typeof h.record.retirement], value);
        assert.equal(h.cleanups(), 0);
        assert.equal(h.records.length, 1);
      }
    });
  }
  it('should protect a dormant owner sharing a checkout with a closed task', async () => {
    const h = setup();
    h.record.worktree = '/shared';
    const peer = {
      ...h.record,
      id: 'dormant-peer',
      sourceThreadId: 'intake',
      worktree: '/shared',
      retirement: assignmentRetirement({
        reason: 'assignment-removed',
        intakeId: h.admitted.id,
        now: baseline,
        graceMinutes: 0,
      }),
    };
    const peerAdmission = {
      ...h.admitted,
      id: 'peer-intake',
      issue: { ...h.admitted.issue, number: 99, nodeId: 'I_peer', databaseId: 99 },
    };
    peer.issueKey = issueKey(peerAdmission);
    peer.intakeId = peerAdmission.id;
    h.admissions.push(peerAdmission);
    h.records.push(peer);
    const getItem = h.fixture.client.getItem;
    h.fixture.client.getItem = async (owner, name, number) =>
      number === 99
        ? { ...h.fixture.item, ...peerAdmission.issue, state: 'open', assignees: [] }
        : getItem(owner, name, number);
    removeFixtureAssignment(h.fixture);
    h.fixture.item.state = 'closed';
    await h.run();
    h.advance(60);
    await h.run();
    assert.equal(h.cleanups(), 0);
    assert.equal(h.record.retirement?.code, 'retirement-worktree-shared');
  });
  it('should retain a closed task deadline across cosmetic activity and fresh effect checks', async () => {
    const h = setup();
    h.fixture.item.state = 'closed';
    await h.run();
    const deadline = h.record.retirement!.eligibleAt;
    h.advance(60);
    h.activity();
    await h.run();
    assert.equal(h.record.retirement!.eligibleAt, deadline);
    assert.ok(h.record.retired);
  });
  for (const closed of [true, false]) {
    it(`should ${closed ? 'ignore' : 'protect'} activity changes during a fresh effect check for ${closed ? 'closed' : 'nonterminal'} retirement`, async () => {
      const h = setup();
      if (closed) h.fixture.item.state = 'closed';
      else h.setArchived();
      await h.run();
      h.advance(60);
      h.beforeRecheck(h.activity);
      await h.run();
      assert.equal(h.cleanups(), closed ? 1 : 0);
      if (!closed) assert.equal(h.record.retirement?.code, 'retirement-observation-changed');
    });
  }
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
    };
    await h.run(h.record.id);
    assert.equal(h.cleanups(), 0);
    assert.equal(h.record.retirement?.code, 'retirement-configuration-invalid');
    h.settings.value = parseCleanupConfiguration();
    await h.run(h.record.id);
    assert.ok(h.record.retired);
  });

  for (const shared of [false, true]) {
    it(`should ${shared ? 'block' : 'complete'} unavailable-session retirement ${shared ? 'with' : 'without'} an active shared owner`, async () => {
      const h = setup();
      h.record.worktree = '/managed/issue';
      h.record.nativeInactive = false;
      h.fixture.item.state = 'closed';
      h.settings.value = parseCleanupConfiguration({ graceMinutes: 0 });
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
  it('should release dormant removal when the live actor list no longer approves it', async () => {
    const h = setup();
    removeFixtureAssignment(h.fixture);
    await h.run();
    assert.equal(h.record.retirement?.reason, 'assignment-removed');
    h.advance(60);
    h.fixture.policy.issueAssignment!.allowed = [];
    await h.run();
    assert.equal(h.cleanups(), 0);
    assert.equal(h.record.retired, undefined);
    h.advance(1);
    await h.run();
    assert.equal(h.record.retirement, undefined);
    assert.equal(h.record.assignmentObservation?.code, 'assignment-removal-unapproved');
  });
  it('should retain newer removal evidence without making it eligible for cleanup', async () => {
    const h = setup();
    const event = removeFixtureAssignment(h.fixture);
    await h.run();
    h.advance(60);
    h.fixture.events.push({ ...event, nodeId: 'E_later_removal', databaseId: 33 });
    await h.run();
    assert.equal(h.cleanups(), 0);
    h.beforeRecheck(() => {});
    h.advance(1);
    await h.run();
    assert.equal(h.record.retirement?.removalEventId, 'E_later_removal');
    assert.equal(workflowStatus(h.record), 'awaiting-reassignment');
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
  it('should reuse awaiting work on verified reassignment', async () => {
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
    assert.equal(h.cleanups(), 1);
  });
  it('should postpone cleanup for a new native turn without restarting it for polls', async () => {
    const h = setup();
    h.setArchived();
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
    };
    h.fixture.item.state = 'closed';
    await h.run();
    h.advance(30);
    await h.run();
    assert.equal(h.record.retired, undefined);
    assert.equal(h.record.retirement?.code, 'retirement-configuration-invalid');
    assert.equal(h.cleanups(), 0);
  });
  it('should begin a full grace only after invalid configuration is repaired', async () => {
    const h = setup();
    h.settings.value = {
      status: 'blocked',
      code: 'retirement-configuration-invalid',
    };
    h.fixture.item.state = 'closed';
    await h.run();
    h.advance(120);
    await h.run();
    assert.equal(h.record.retirement?.deadlinePending, true);
    h.settings.value = parseCleanupConfiguration({ graceMinutes: 17 });
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
    h.settings.value = parseCleanupConfiguration({ graceMinutes: 43200 });
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
      h.settings.value = parseCleanupConfiguration({ graceMinutes: 0 });
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
  for (const count of [2, 14]) {
    it(`should archive ${count} eligible shared owners across bounded passes and reclaim once`, async () => {
      const h = setup();
      h.fixture.item.state = 'closed';
      h.record.worktree = '/managed/shared';
      for (let n = 1; n < count; n++) h.records.push({ ...h.record, id: `peer-${n}` });
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
      for (let pass = 0; pass < (count > 12 ? 6 : 3); pass++) {
        await run();
        now += 3_600_000;
      }
      assert.equal(archived.size, count);
      assert.equal(removals, 1);
      assert.ok(h.records.every((record) => record.retired));
    });
  }
  for (const condition of ['busy', 'unknown', 'grace', 'pending-deadline', 'legacy'] as const) {
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
                activityId: 'turn-1',
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
    };
    removeFixtureAssignment(h.fixture);
    h.setBusy(true);
    await h.run();
    assert.equal(Boolean(h.record.retired), false);
    h.setBusy(false);
    h.advance(1);
    await h.run();
    assert.equal(h.record.retired, undefined);
    assert.equal(workflowStatus(h.record), 'awaiting-reassignment');
    assert.equal(h.record.retirement?.code, undefined);
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
      assert.equal(h.record.retirement?.reason, closed ? 'issue-closed' : 'chat-archived');
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
