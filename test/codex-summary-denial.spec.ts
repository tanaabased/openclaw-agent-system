import assert from 'node:assert/strict';
import codexSummaryDenial from '../agent/codex-summary-denial.ts';
import codexTurnApprovalDenied from '../agent/codex-turn-approval.ts';
import type { AssessmentSummary } from '../agent/assessment-summary-state.ts';

const command =
  '\'/node\' \'/plugin/runtime.js\' \'dispatch\' \'summary\' \'--plugin-data\' \'/data\' <<\'AGENT_SYSTEM_INPUT\'\n{"action":"summary","id":"issue","operation":"publish","digest":"draft"}\nAGENT_SYSTEM_INPUT';
const held = () =>
  ({
    code: 'assessment-summary-native-approval-denied',
    turnId: 'assessment',
    binding: { workflow: 'issue-assignment', threadId: 'issue' },
    publicationCommand: command,
    previewDigest: 'a'.repeat(64),
    publicText: 'Proposed change.',
  }) as AssessmentSummary;

describe('agent/codex-summary-denial', () => {
  it('should exclude only the exact held summary non-execution and retain its native identity', () => {
    const summary = held();
    const items = [{ id: 'refusal', type: 'commandExecution', status: 'declined', command }];
    assert.equal(codexTurnApprovalDenied(items), true);
    assert.equal(
      codexTurnApprovalDenied(codexSummaryDenial(items, 'issue', 'assessment', [summary])),
      false,
    );
    assert.equal(summary.nativeDenial?.callId, 'refusal');
    assert.equal(summary.nativeDenial?.turnId, 'assessment');
  });
  for (const change of [
    { command: command + '\nother-command' },
    { command: command.replace('publish', 'implementation-context') },
    { processId: 'executed' },
    { exitCode: 1 },
    { id: undefined },
  ])
    it('should preserve broader or unverified native refusal', () => {
      const item = {
        id: 'refusal',
        type: 'commandExecution',
        status: 'declined',
        command,
        ...change,
      };
      assert.equal(
        codexTurnApprovalDenied(codexSummaryDenial([item], 'issue', 'assessment', [held()])),
        true,
      );
    });
  it('should preserve unrelated denials and mismatched issue turn or summary state', () => {
    const item = { id: 'refusal', type: 'commandExecution', status: 'declined', command };
    const broader = { type: 'fileChange', status: 'declined' };
    assert.equal(
      codexTurnApprovalDenied(codexSummaryDenial([item, broader], 'issue', 'assessment', [held()])),
      true,
    );
    for (const [thread, turn] of [
      ['other', 'assessment'],
      ['issue', 'other'],
    ])
      assert.equal(
        codexTurnApprovalDenied(codexSummaryDenial([item], thread!, turn!, [held()])),
        true,
      );
    for (const summary of [
      { ...held(), code: undefined },
      { ...held(), attempt: 'uncertain' },
      { ...held(), receipt: { nodeId: 'posted', databaseId: 1 } },
    ])
      assert.equal(
        codexTurnApprovalDenied(codexSummaryDenial([item], 'issue', 'assessment', [summary])),
        true,
      );
  });
});
