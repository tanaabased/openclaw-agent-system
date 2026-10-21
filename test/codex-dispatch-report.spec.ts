import assert from 'node:assert/strict';
import prepareDispatchReport from '../agent/codex-dispatch-report.ts';
import type { DispatchState, DispatchRecord } from '../agent/codex-dispatch-state.ts';
import { issueKey } from '../agent/dispatch-pending.ts';
import type { IntakeState, IntakeRecord } from '../channels/github/intake/record-store.ts';

const state: DispatchState = { version: 1, scope: 'scope', records: [] };
const intake: IntakeState = {
  version: 1,
  scope: 'scope',
  workspaceDir: '/workspace',
  agentId: 'agent',
  account: { login: 'agent', nodeId: 'actor' },
  policyDigest: 'policy',
  baselineAt: 0,
  records: [],
};
const input = {
  state,
  intake,
  slots: 2,
  automationId: 'intake',
  currentTimeIso: '2026-10-12T12:00:00.000Z',
};
describe('agent/codex-dispatch-report', () => {
  it('should keep native retirement progress healthy through completion without a recovery alert', () => {
    const record = {
      id: 'retiring',
      intakeId: 'assignment',
      phase: 'complete',
      retirement: {
        reason: 'issue-closed',
        at: 1,
        eligibleAt: 2,
        checkedAt: 3,
        intakeId: 'assignment',
      },
    } as DispatchRecord;
    const current = { ...input, state: { ...state, records: [record], intakeHealth: '' } };
    for (const code of [
      'retirement-native-archive-unverified',
      'retirement-native-reclamation-pending',
    ]) {
      record.retirement!.code = code;
      const report = prepareDispatchReport(current);
      assert.equal(report.health, '');
      assert.match(report.response, /DONT_NOTIFY/);
      assert.match(report.response, /retirement in progress/);
      assert.match(report.response, /No action is needed/);
      assert.match(report.response, /\*\*Retirement pending:\*\* 1/);
      assert.doesNotMatch(report.response, /⚠️|needs attention|Intake resumed/);
      current.state.intakeHealth = report.health;
    }
    const blocked = {
      ...record,
      id: 'blocked',
      retirement: { ...record.retirement!, code: 'retirement-worktree-dirty' },
    };
    const mixed = prepareDispatchReport({
      ...current,
      state: { ...current.state, records: [record, blocked] },
    });
    assert.notEqual(mixed.health, '');
    assert.match(mixed.response, /NOTIFY/);
    assert.match(mixed.response, /⚠️/);
    assert.match(mixed.response, /retirement-worktree-dirty/);

    record.retired = { at: 4, by: 'operator' };
    const completed = prepareDispatchReport(current);
    assert.equal(completed.health, '');
    assert.match(completed.response, /DONT_NOTIFY/);
    assert.match(completed.response, /\*\*Retirement pending:\*\* 0/);
    assert.doesNotMatch(completed.response, /Intake resumed|problem has cleared/);
  });

  it('should report retirement blockers once without turning grace or inventory waits into warnings', () => {
    const record = {
      id: 'retiring',
      intakeId: 'assignment',
      phase: 'complete',
      retirement: {
        reason: 'issue-closed',
        at: 1,
        eligibleAt: 2,
        checkedAt: 3,
        intakeId: 'assignment',
        code: 'retirement-worktree-shared',
      },
    } as DispatchRecord;
    const current = {
      ...input,
      state: { ...state, records: [record] },
      intake: {
        ...intake,
        records: [
          {
            id: 'assignment',
            scope: 'scope',
            receiving: { nodeId: 'user' },
            repository: { nodeId: 'repo', owner: { login: 'owner' }, name: 'repo' },
            issue: { nodeId: 'issue', number: 32 },
          } as IntakeRecord,
        ],
      },
    };
    record.issueKey = issueKey(current.intake.records[0]!);
    const first = prepareDispatchReport(current);
    assert.match(first.response, /owner\/repo#32/);
    assert.match(first.response, /retirement-worktree-shared/);
    assert.match(first.response, /retirement cleanup/);
    assert.match(first.response, /<decision>NOTIFY<\/decision>/);
    assert.match(
      prepareDispatchReport({ ...current, state: { ...current.state, intakeHealth: first.health } })
        .response,
      /DONT_NOTIFY/,
    );
    record.retirement!.code = 'retirement-worktree-dirty';
    assert.notEqual(prepareDispatchReport(current).health, first.health);
    record.retirement!.eligibleAt = Date.parse(input.currentTimeIso) + 1;
    assert.match(prepareDispatchReport(current).response, /DONT_NOTIFY/);
    record.retirement!.eligibleAt = 2;
    for (const code of [
      'retirement-native-inventory-required',
      'retirement-native-archive-pending',
      'retirement-awaiting-reactivation',
    ]) {
      record.retirement!.code = code;
      assert.match(prepareDispatchReport(current).response, /DONT_NOTIFY/);
    }
    record.retired = { at: 4, by: 'operator' };
    const recovered = prepareDispatchReport({
      ...current,
      state: { ...current.state, intakeHealth: first.health },
    });
    assert.equal(recovered.health, '');
    assert.match(recovered.response, /<decision>NOTIFY<\/decision>/);
  });
  it('should report a deferred assignment without saying unrelated intake is paused', () => {
    const current = {
      ...intake,
      deferred: [
        {
          key: 'one',
          code: 'intake-assignment-history-incomplete',
          candidate: JSON.stringify({ repositoryPath: '/repos/owner/repo', number: 3 }),
        },
      ],
    };
    const report = prepareDispatchReport({ ...input, intake: current });
    assert.match(report.response, /owner\/repo#3/);
    assert.match(report.response, /intake-assignment-history-incomplete/);
    assert.match(report.response, /Unrelated intake continues/);
    assert.doesNotMatch(report.response, /Issue checks are temporarily paused/);
    assert.match(
      prepareDispatchReport({
        ...input,
        intake: current,
        state: { ...state, intakeHealth: report.health },
      }).response,
      /DONT_NOTIFY/,
    );
  });

  it('should report an automation update once and preserve the first-setup distinction', () => {
    const current = {
      ...intake,
      blocker: {
        code: 'intake-automation-update-required',
        since: 1,
        retryAfter: 2,
      },
    };
    const update = prepareDispatchReport({ ...input, intake: current });
    assert.match(update.response, /> ## ✨ Automation update available/);
    assert.match(update.response, /New intake is paused/);
    assert.match(update.response, /Install.*update.*resume intake/);
    assert.match(update.response, /`intake-automation-update-required`/);
    assert.match(update.response, /<decision>NOTIFY<\/decision>/);
    const repeat = prepareDispatchReport({
      ...input,
      intake: current,
      state: { ...state, intakeHealth: update.health },
    });
    assert.match(repeat.response, /DONT_NOTIFY/);
    const initial = prepareDispatchReport({
      ...input,
      intake: { ...current, blocker: { ...current.blocker, code: 'intake-activation-required' } },
    });
    assert.match(initial.response, /> ## ⚠️ Set up intake automation/);
    assert.doesNotMatch(initial.response, /update available/);
  });

  it('should show progress transitions as information cards without repeating unchanged notices', () => {
    const progress = { pending: true, sources: 4, reported: undefined as boolean | undefined };
    const current = { ...input, state: { ...state, discoveryProgress: progress } };
    assert.match(prepareDispatchReport(current).response, /> ## 💡 Intake discovery continues/u);
    assert.doesNotMatch(prepareDispatchReport(current).response, /DONT_NOTIFY/);
    progress.reported = true;
    assert.match(prepareDispatchReport(current).response, /DONT_NOTIFY/);
    progress.pending = false;
    assert.match(prepareDispatchReport(current).response, /> ## 💡 Intake discovery caught up/u);
    progress.reported = false;
    assert.match(prepareDispatchReport(current).response, /DONT_NOTIFY/);
  });
  it('should render quiet counts using the existing message rotation', () => {
    const report = prepareDispatchReport(input);
    assert.match(report.response, /DONT_NOTIFY/);
    assert.match(report.response, /Active:\*\* 0 issues/);
    assert.match(report.response, /Pending:\*\* 0/);
    assert.match(report.response, /Slots:\*\* 0\/2 occupied/);
    assert.deepEqual(report.started, []);
    const message = report.response.split('<message>')[1]!.split('</message>')[0]!;
    assert.ok(message.startsWith('> ## 💡'));
    assert.ok(message.split('\n').every((line) => line.startsWith('>')));
  });
  it('should report an intake failure and recovery without repeating notifications', () => {
    const blocked = {
      ...intake,
      blocker: { code: 'intake-provider-unavailable', since: 1, retryAfter: 2 },
    };
    const first = prepareDispatchReport({ ...input, intake: blocked });
    assert.match(first.response, /NOTIFY/);
    assert.match(first.response, /⚠️/);
    assert.match(first.response, /> ## ⚠️/);
    assert.match(first.response, /> {3}\*\*Diagnostic:\*\*/);
    const next = { ...state, intakeHealth: first.health };
    assert.match(
      prepareDispatchReport({ ...input, state: next, intake: blocked }).response,
      /DONT_NOTIFY/,
    );
    const recovered = prepareDispatchReport({ ...input, state: next });
    assert.match(recovered.response, /Intake resumed/);
    assert.equal(recovered.health, '');
  });
  it('should report only verified feedback sends and keep response contents out of intake', () => {
    const record = {
      id: 'owner',
      intakeId: 'assignment',
      phase: 'complete',
      request: {},
      effective: {},
      threadId: 'chat',
      feedback: {
        baseline: {},
        events: [
          {
            id: 'sent',
            phase: 'running',
            attempt: { turnId: 'native-turn' },
            result: { privateText: 'PRIVATE', publicText: 'PUBLIC' },
          },
          { id: 'unsent', phase: 'queued' },
        ],
      },
    } as DispatchRecord;
    const first = prepareDispatchReport({
      ...input,
      slots: 3,
      state: { ...state, records: [record] },
    });
    assert.deepEqual(first.sent, ['sent']);
    assert.match(first.response, /1 feedback item delivered to chats/);
    assert.match(first.response, /Queued feedback:\*\* 1 item across 1 issue/);
    assert.match(first.response, /Slots:\*\* 1\/3 occupied/);
    assert.doesNotMatch(first.response, /PRIVATE|PUBLIC/);
    record.feedback!.events.push({ ...record.feedback!.events[0]!, id: 'second' });
    const grouped = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.deepEqual(grouped.sent, ['sent', 'second']);
    assert.equal(grouped.response.match(/codex:\/\/threads\/chat/g)?.length, 1);
    assert.match(grouped.response, /2 items/);
    record.feedback!.events[2]!.reported = true;
    record.feedback!.events[0]!.reported = true;
    const repeated = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.match(repeated.response, /DONT_NOTIFY/);
    assert.deepEqual(repeated.sent, []);
  });
  it('should distinguish failed intake state from a temporary provider warning', () => {
    const report = prepareDispatchReport({
      ...input,
      intake: { ...intake, blocker: { code: 'intake-state-invalid', since: 1, retryAfter: 2 } },
    });
    assert.match(report.response, /❌/);
    assert.match(report.response, /intake-state-invalid/);
  });
  it('should keep inactive historical assignments out of feedback intake warnings', () => {
    const record = {
      id: 'historical',
      phase: 'complete',
      feedback: {
        baseline: {},
        events: [],
        code: 'dispatch-assignment-authority-revoked',
      },
    } as unknown as DispatchRecord;
    const quiet = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.match(quiet.response, /DONT_NOTIFY/);
    assert.doesNotMatch(quiet.response, /authority-revoked/);
    record.feedback!.events.push({ id: 'waiting', phase: 'queued' } as never);
    const pending = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.match(pending.response, /authority-revoked/);
    assert.notEqual(pending.health, '');
  });
  it('should scope an item failure while preserving a successful start', () => {
    const started = {
      id: 'good',
      intakeId: 'good',
      phase: 'assessing',
      effective: { status: 'verified' },
      threadId: 'good-chat',
      dispatchedAt: 1,
    } as DispatchRecord;
    const failed = {
      id: 'bad',
      intakeId: 'bad',
      phase: 'waiting',
      result: {
        outcome: 'operator-setup-blocker',
        code: 'dispatch-operation-failed',
        remediation: 'Inspect the retained request.',
      },
    } as DispatchRecord;
    const report = prepareDispatchReport({
      ...input,
      state: { ...state, records: [started, failed] },
    });
    assert.deepEqual(report.started, ['good']);
    assert.match(report.response, /codex:\/\/threads\/good-chat/);
    assert.match(report.response, /Operation:\*\* assignment preparation/);
    assert.match(report.response, /Status:\*\* waiting/);
    assert.doesNotMatch(report.response, /Intake could not finish/);
  });
  it('should keep closed historical feedback quiet but retain unresolved execution and publication diagnostics', () => {
    const record = {
      id: 'owner',
      phase: 'complete',
      feedback: { baseline: {}, code: 'dispatch-issue-closed', events: [] },
    } as unknown as DispatchRecord;
    const report = () =>
      prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.match(report().response, /DONT_NOTIFY/);
    record.feedback!.events.push({ phase: 'blocked', publicationAttempted: true } as never);
    assert.match(report().response, /dispatch-issue-closed/);
    record.feedback!.events = [
      { phase: 'blocked', reported: true, attempt: { turnId: 'run' } } as never,
    ];
    assert.match(report().response, /dispatch-issue-closed/);
    record.nativeInactive = true;
    assert.match(report().response, /DONT_NOTIFY/);
    record.feedback!.events = [{ phase: 'queued' } as never];
    assert.match(report().response, /dispatch-issue-closed/);
  });
  it('should keep obsolete reservations quiet unless they obstruct new work or occupy capacity', () => {
    const record = {
      id: 'legacy',
      intakeId: 'old',
      phase: 'blocked',
      request: {},
      retired: { at: 1 },
      capacityObservation: { at: 2, code: 'dispatch-capacity-creation-unresolved' },
    } as DispatchRecord;
    const successor = {
      id: 'new',
      scope: 'scope',
      receiving: { nodeId: 'user' },
      repository: { nodeId: 'repo', owner: { login: 'owner' }, name: 'repo' },
      issue: { nodeId: 'issue', number: 1 },
      assignment: { createdAt: new Date(3).toISOString() },
    } as IntakeRecord;
    record.issueKey = issueKey(successor);
    const currentIntake = { ...intake, records: [] as IntakeRecord[] };
    const report = () =>
      prepareDispatchReport({
        ...input,
        intake: currentIntake,
        state: { ...state, records: [structuredClone(record)] },
      });
    assert.match(report().response, /DONT_NOTIFY/);
    assert.doesNotMatch(report().response, /Historical reservations/);
    assert.ok(record.request);
    currentIntake.records = [successor];
    const first = report();
    assert.match(first.response, /Slots:\*\* 0\/2/);
    assert.match(first.response, /Historical reservations:\*\* 1 unresolved/);
    assert.match(first.response, /preparation turn/);
    assert.match(
      prepareDispatchReport({
        ...input,
        intake: currentIntake,
        state: { ...state, intakeHealth: first.health, records: [record] },
      }).response,
      /DONT_NOTIFY/,
    );
    const laterRetired = {
      ...record,
      id: 'later',
      intakeId: successor.id,
      retired: { at: 4, by: 'operator' },
    };
    const finished = prepareDispatchReport({
      ...input,
      intake: currentIntake,
      state: { ...state, records: [record, laterRetired] },
    });
    assert.match(finished.response, /DONT_NOTIFY/);
    assert.doesNotMatch(finished.response, /Historical reservations/);
    currentIntake.records = [];
    record.reservationVersion = 1;
    record.capacityObservation = { at: 3, code: 'dispatch-capacity-native-active' };
    assert.match(report().response, /dispatch-capacity-native-active/);
    assert.match(report().response, /Slots:\*\* 1\/2/);
  });
});
