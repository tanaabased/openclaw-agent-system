import assert from 'node:assert/strict';

import openclawIntakeReport from '../agent/openclaw-intake-report.ts';
import type { OpenClawDispatchState } from '../agent/openclaw-dispatch-state.ts';

function state(): OpenClawDispatchState {
  return { version: 1, scope: 'a'.repeat(64), records: [] };
}

describe('agent/openclaw-intake-report', () => {
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
    assert.match(report.response, /Status:\*\* waiting/);
    assert.match(report.response, /assignment-history/);
    assert.doesNotMatch(report.response, /pending assignments are unknown/);
  });
});
