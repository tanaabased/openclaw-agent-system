import assert from 'node:assert/strict';

import type { OpenClawDispatchState } from '../agent/openclaw-dispatch-state.ts';
import openclawIntakeReport from '../agent/openclaw-intake-report.ts';

function state(): OpenClawDispatchState {
  return {
    version: 4,
    scope: 'a'.repeat(64),
    records: [],
  };
}

describe('agent/openclaw-intake-report', () => {
  it('should count dormant owners separately without warning or starting them', () => {
    const journal = state();
    const record = {
      id: 'held',
      request: {},
      phase: 'complete',
      threadId: 'original',
      sessionCreation: { verified: true },
      nativeInactive: true,
      retirement: { reason: 'assignment-removed', code: 'retirement-worktree-dirty' },
    } as OpenClawDispatchState['records'][number];
    journal.records.push(record);
    const before = structuredClone(record);
    const report = openclawIntakeReport({
      state: journal,
      slots: 2,
      observation: { status: 'ready', changed: false },
    });
    assert.deepEqual(report.problems, []);
    assert.match(report.response, /Awaiting reassignment:\*\* 1/);
    assert.match(report.response, /Retirement pending:\*\* 0/);
    assert.match(report.response, /Slots:\*\* 0\/2/);
    assert.doesNotMatch(report.response, /retirement-worktree-dirty|Started|⚠️/);
    assert.deepEqual(record, before);
  });
  it('should attribute a current pr stall to the explicit link rather than historical delivery', () => {
    const journal = state();
    const owner = {
      id: 'a'.repeat(64),
      createdAt: 1,
      sourceThreadId: 'coordinator',
      issueKey: 'c'.repeat(64),
      manifestDigest: 'manifest',
      intakeId: 'b'.repeat(64),
      phase: 'complete',
      threadId: 'chat',
      sessionCreation: { verified: true },
      intakeReportedAt: 1,
      pullRequestLink: { pullRequestNodeId: 'PR_8', pullRequestNumber: 8 },
      work: { delivery: { pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 } } },
      feedback: {
        baseline: {},
        events: [],
        code: 'feedback-discovery-no-progress',
        discoveryStalls: { PR_8: { operation: 'comments:1', attempts: 3 } },
      },
    } as unknown as OpenClawDispatchState['records'][number];
    journal.records.push(owner);
    const intake = {
      records: [
        {
          id: owner.intakeId,
          issue: { number: 3 },
          repository: { owner: { login: 'owner' }, name: 'repo' },
        },
      ],
    } as NonNullable<Parameters<typeof openclawIntakeReport>[0]['intake']>;
    const report = openclawIntakeReport({
      state: journal,
      intake,
      slots: 3,
      observation: { status: 'ready', changed: false },
    });
    assert.match(report.response, /\[PR #8\]\(https:\/\/github.com\/owner\/repo\/pull\/8\)/);
    assert.doesNotMatch(report.response, /\/pull\/7/);
  });
  it('should keep retirement progress quiet and report real blockers once', () => {
    const journal = state();
    const record = {
      id: 'a'.repeat(64),
      intakeId: 'b'.repeat(64),
      phase: 'complete',
      retirement: {
        reason: 'issue-closed',
        at: 1,
        checkedAt: 1,
        eligibleAt: 1,
        intakeId: 'b'.repeat(64),
        code: 'retirement-shared-archive-pending',
      },
    } as OpenClawDispatchState['records'][number];
    journal.records.push(record);
    const input = {
      state: journal,
      slots: 3,
      observation: { status: 'ready' as const, changed: false },
    };
    const progress = openclawIntakeReport(input);
    assert.equal(progress.changed, false);
    assert.deepEqual(progress.problems, []);
    assert.match(progress.response, /No action is needed/);
    journal.intakeReport = { ...progress, runId: 'progress' };
    record.retirement!.code = 'retirement-session-identity-unresolved';
    const blocked = openclawIntakeReport(input);
    assert.equal(blocked.changed, true);
    assert.match(blocked.response, /session receipt/);
    journal.intakeReport = { ...blocked, runId: 'blocked' };
    assert.equal(openclawIntakeReport(input).changed, false);
    record.retirement!.code = 'retirement-shared-archive-pending';
    const cleared = openclawIntakeReport(input);
    assert.equal(cleared.changed, true);
    assert.match(cleared.response, /Retirement blocker cleared/);
    journal.intakeReport = { ...cleared, runId: 'cleared' };
    record.retirement!.archivedAt = 2;
    record.retirement!.worktreeRemovedAt = 2;
    journal.records.splice(journal.records.indexOf(record), 1);
    const complete = openclawIntakeReport(input);
    assert.equal(complete.changed, false);
    assert.match(complete.response, /Retirement pending:\*\* 0/);
    assert.doesNotMatch(complete.response, /Intake resumed/);
  });

  it('should report deferred assignments as item failures and recognize their recovery', () => {
    const journal = state();
    const intake = {
      version: 1 as const,
      scope: journal.scope,
      workspaceDir: '/workspace',
      agentId: 'agent',
      account: { login: 'agent', nodeId: 'actor' },
      policyDigest: 'policy',
      baselineAt: 0,
      records: [],
      deferred: [
        {
          key: 'one',
          code: 'intake-assignment-history-incomplete',
          candidate: JSON.stringify({ repositoryPath: '/repos/owner/repo', number: 3 }),
        },
      ],
    };
    const input = {
      state: journal,
      intake,
      slots: 2,
      observation: { status: 'ready' as const, changed: false },
    };
    const report = openclawIntakeReport(input);
    assert.match(report.response, /owner\/repo#3/);
    assert.match(report.response, /Unrelated intake continues/);
    assert.equal(report.changed, true);
    journal.intakeReport = { ...report, runId: 'one' };
    assert.equal(openclawIntakeReport(input).changed, false);
    intake.deferred = [];
    const recovered = openclawIntakeReport(input);
    assert.equal(recovered.changed, true);
    assert.match(recovered.response, /condition has cleared/);
  });

  it('should keep healthy unchanged checks silent and report changed blockers and recovery once', () => {
    const journal = state();
    const prepare = (code?: string) =>
      openclawIntakeReport({
        state: journal,
        slots: 2,
        observation: {
          status: code ? 'blocked' : 'ready',
          changed: false,
          ...(code ? { code } : {}),
        },
      });
    assert.equal(prepare().changed, false);
    const blocked = prepare('intake-automation-update-required');
    assert.equal(blocked.changed, true);
    assert.match(blocked.response, /> ## ✨ Automation update available/);
    assert.match(blocked.response, /New intake is paused/);
    assert.match(blocked.response, /Existing chats and work are retained/);
    assert.match(blocked.response, /Agent System Install/);
    assert.match(blocked.response, /`intake-automation-update-required`/);
    const initial = prepare('intake-activation-required');
    assert.match(initial.response, /> ## ⚠️ Set up intake automation/);
    assert.doesNotMatch(initial.response, /update available/);
    assert.doesNotMatch(blocked.response, /Pending:\*\* 0/);
    journal.intakeReport = { ...blocked, runId: 'one' };
    assert.equal(prepare('intake-automation-update-required').changed, false);
    const changed = prepare('automation-execution-failed');
    assert.equal(changed.changed, true);
    assert.doesNotMatch(changed.response, /earlier intake condition has cleared/);
    journal.intakeReport = { ...changed, runId: 'two' };
    const recovered = prepare();
    assert.equal(recovered.changed, true);
    assert.match(recovered.response, /Intake resumed/);
    journal.intakeReport = { ...recovered, runId: 'three' };
    assert.equal(prepare().changed, false);
    assert.equal(
      openclawIntakeReport({
        state: structuredClone(journal),
        slots: 2,
        observation: { status: 'ready', changed: false },
      }).changed,
      false,
    );
  });

  it('should preserve verified starts beside partial failure without exposing assessment payloads', () => {
    const journal = state();
    journal.records.push({
      id: 'b'.repeat(64),
      intakeId: 'c'.repeat(64),
      issueKey: 'd'.repeat(64),
      manifestDigest: 'manifest',
      sourceThreadId: 'coordinator',
      phase: 'created',
      createdAt: 1,
      threadId: 'agent:receiver:issue:1',
      sessionCreation: {
        attempted: true,
        verified: true,
        sourceSessionId: 'coordinator',
        sourceRunId: 'run',
        sourceToolCallId: 'tool',
        sessionId: 'one',
      },
      request: {
        key: 'agent:receiver:issue:1',
        idempotencyKey: 'receipt',
        agentId: 'receiver',
        label: 'Issue',
        category: 'repo',
        cwd: '/work',
        model: 'model',
        thinkingLevel: 'high',
      },
      context: 'HIDDEN-PROVIDER-PAYLOAD',
    });
    const report = openclawIntakeReport({
      state: journal,
      slots: 2,
      observation: { status: 'blocked', code: 'intake-search-incomplete', changed: true },
    });
    assert.equal(report.started.length, 1);
    assert.match(report.response, /chat\?session=agent%3Areceiver%3Aissue%3A1/);
    assert.match(report.response, /1\/2 occupied · 1 available/);
    assert.match(report.response, /pending assignments are unknown/);
    assert.doesNotMatch(report.response, /HIDDEN-PROVIDER-PAYLOAD|Queued feedback|plan-ready/);
  });
  it('should identify the affected issue and operation without claiming the scan failed', () => {
    const journal = state();
    journal.records.push({
      id: 'a'.repeat(64),
      intakeId: 'b'.repeat(64),
      issueKey: 'c'.repeat(64),
      sourceThreadId: 'coordinator',
      phase: 'waiting',
      createdAt: 0,
      manifestDigest: 'digest',
      blocker: 'dispatch-assignment-event-missing',
      failureStage: 'preparation',
    } as never);
    const report = openclawIntakeReport({
      state: journal,
      slots: 2,
      observation: { status: 'ready', changed: true },
    });
    assert.match(report.response, /Issue:/);
    assert.match(report.response, /Operation:\*\* preparation/);
    assert.match(report.response, /dispatch-assignment-event-missing/);
    assert.match(report.response, /assignment-history/);
    assert.doesNotMatch(report.response, /pending assignments are unknown/);
  });
});
