import assert from 'node:assert/strict';
import prepareDispatchReport from '../agent/codex-dispatch-report.ts';
import type { DispatchRecord, DispatchState } from '../agent/codex-dispatch-state.ts';
import { issueKey } from '../agent/dispatch-pending.ts';
import type { IntakeRecord, IntakeState } from '../channels/github/intake/record-store.ts';

const state: DispatchState = {
  version: 4,
  scope: 'scope',
  records: [],
};
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
  it('should count dormant owners separately without warning or starting them', () => {
    const record = {
      id: 'held',
      request: {},

      threadId: 'original',
      effective: { status: 'verified' },
      dispatchedAt: 1,
      nativeInactive: true,
      retirement: {
        reason: 'assignment-removed',
        code: 'retirement-worktree-dirty',
        eligibleAt: 0,
      },
    } as DispatchRecord;
    const before = structuredClone(record);
    const report = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.equal(report.health, '');
    assert.match(report.response, /Awaiting reassignment:\*\* 1/);
    assert.match(report.response, /Retirement pending:\*\* 0/);
    assert.match(report.response, /Slots:\*\* 0\/2/);
    assert.doesNotMatch(report.response, /retirement-worktree-dirty|Started|⚠️/);
    assert.deepEqual(record, before);
  });
  it('should identify a manual launch blocker without an assignment record', () => {
    const record = {
      id: 'manual',
      blocker: 'dispatch-denial-history-unavailable',
      manualIssue: {
        id: 'manual',
        repository: { owner: { login: 'owner' }, name: 'repo' },
        issue: { number: 123 },
      },
    } as DispatchRecord;
    const report = prepareDispatchReport({
      ...input,
      state: { ...state, records: [record] },
    });
    assert.match(report.response, /owner\/repo#123/);
    assert.match(report.response, /dispatch-denial-history-unavailable/);
    assert.doesNotMatch(report.response, /Issue: Issue/);
  });

  it('should keep native retirement progress healthy through completion without a recovery alert', () => {
    const record = {
      id: 'retiring',
      intakeId: 'assignment',

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

    record.retirement!.archivedAt = 4;
    record.retirement!.worktreeRemovedAt = 4;
    current.state.records.splice(current.state.records.indexOf(record), 1);
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
    record.retirement!.archivedAt = 4;
    record.retirement!.worktreeRemovedAt = 4;
    current.state.records.splice(current.state.records.indexOf(record), 1);
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
    assert.match(prepareDispatchReport(current).response, /> ## 📥 Intake discovery continues/u);
    assert.doesNotMatch(prepareDispatchReport(current).response, /DONT_NOTIFY/);
    progress.reported = true;
    assert.match(prepareDispatchReport(current).response, /DONT_NOTIFY/);
    progress.pending = false;
    assert.match(prepareDispatchReport(current).response, /> ## 📥 Intake discovery caught up/u);
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
    assert.ok(message.startsWith('> ## 📥'));
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
  it('should report queued feedback counts without a delivery lifecycle feed', () => {
    const record = {
      id: 'owner',
      intakeId: 'assignment',

      request: {},
      effective: {},
      threadId: 'chat',
      feedback: {
        baseline: {},
        events: [
          {
            id: 'sent',
            attempt: { turnId: 'native-turn' },
          },
          { id: 'unsent', phase: 'queued' },
          { id: 'prepared', phase: 'prepared', code: 'feedback-send-unresolved' },
          { id: 'running', phase: 'running' },
        ],
      },
    } as DispatchRecord;
    const first = prepareDispatchReport({
      ...input,
      slots: 3,
      state: { ...state, records: [record] },
    });
    assert.doesNotMatch(first.response, /feedback item delivered to chats/);
    assert.match(first.response, /Queued feedback:\*\* 3 items across 1 issue/);
    assert.match(first.response, /feedback-send-unresolved/);
    assert.match(first.response, /NOTIFY/);
    assert.notEqual(first.health, '');
    assert.match(first.response, /Slots:\*\* 1\/3 occupied/);
    assert.doesNotMatch(first.response, /PRIVATE|PUBLIC/);
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

      feedback: {
        baseline: {},
        events: [],
        code: 'dispatch-assignment-removed',
      },
    } as unknown as DispatchRecord;
    const quiet = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.match(quiet.response, /DONT_NOTIFY/);
    assert.doesNotMatch(quiet.response, /assignment-removed/);
    record.feedback!.events.push({ id: 'waiting', phase: 'queued' } as never);
    const pending = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.match(pending.response, /assignment-removed/);
    assert.notEqual(pending.health, '');
  });
  it('should scope an item failure while preserving a successful start', () => {
    const started = {
      id: 'good',
      intakeId: 'good',

      effective: { status: 'verified' },
      threadId: 'good-chat',
      dispatchedAt: 1,
    } as DispatchRecord;
    const failed = {
      id: 'bad',
      intakeId: 'bad',
      blocker: 'dispatch-operation-failed',
    } as DispatchRecord;
    const report = prepareDispatchReport({
      ...input,
      state: { ...state, records: [started, failed] },
    });
    assert.deepEqual(report.started, ['good']);
    assert.match(report.response, /codex:\/\/threads\/good-chat/);
    assert.match(report.response, /Operation:\*\* assignment preparation/);
    assert.match(report.response, /dispatch-operation-failed/);
    assert.doesNotMatch(report.response, /Intake could not finish/);
  });
  it('should report current retirement and native denial obstacles regardless of debug visibility', () => {
    for (const code of [
      'retirement-worktree-dirty',
      'retirement-worktree-shared',
      'retirement-native-resource-protected',
      'retirement-worktree-unpreserved',
    ]) {
      const blocked = { id: 'blocked', retirement: { code, eligibleAt: 1 } } as DispatchRecord;
      for (const debug of [undefined, false, true]) {
        const report = prepareDispatchReport({
          ...input,
          debug,
          state: { ...state, records: [blocked] },
        });
        assert.notEqual(report.health, '');
        assert.match(report.response, /<decision>NOTIFY<\/decision>/);
        assert.ok(report.response.includes(code));
        assert.match(
          prepareDispatchReport({
            ...input,
            debug,
            state: { ...state, records: [blocked], intakeHealth: report.health },
          }).response,
          /DONT_NOTIFY/,
        );
      }
    }
    const denied = {
      id: 'denied',
      blocker: 'native-approval-denied',
    } as DispatchRecord;
    for (const debug of [undefined, false, true]) {
      const report = prepareDispatchReport({
        ...input,
        debug,
        state: { ...state, records: [denied] },
      });
      assert.notEqual(report.health, '');
      assert.match(report.response, /<decision>NOTIFY<\/decision>/);
      assert.match(report.response, /native-approval-denied/);
    }
  });
});
