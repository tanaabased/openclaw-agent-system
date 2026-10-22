import assert from 'node:assert/strict';
import issueWorkflowProgress, {
  type IssueWorkflowState,
} from '../agent/issue-workflow-progress.ts';
import workflowStatus from '../agent/workflow-status.ts';

describe('agent/issue-workflow-progress', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    const record = (outcome: string): IssueWorkflowState => ({
      phase: 'complete',
      progression: { stage: 'implementation' },
      ...(runtime === 'codex'
        ? {
            continuation: {
              phase: outcome === 'clarification-needed' ? outcome : 'delivery',
              result: { outcome },
            },
          }
        : {
            continuation: { message: 'Retained assessment transport.' },
            work: { result: { outcome } },
          }),
    });
    it(`should keep ${runtime} questions waiting without changing authorization`, () => {
      const issue = record('clarification-needed');
      const before = structuredClone(issue);
      assert.deepEqual(issueWorkflowProgress(issue), {
        action: 'wait-input',
        status: 'clarification-needed',
      });
      assert.deepEqual(issue, before);
      assert.equal(workflowStatus(issue), 'clarification-needed');
    });
    it(`should derive ${runtime} delivery and completion from the actual receipts`, () => {
      const issue = record('done');
      if (issue.continuation?.phase) issue.continuation.phase = 'complete';
      assert.equal(issueWorkflowProgress(issue).action, 'delivery');
      const delivery = {
        pullRequest: { pullRequestNumber: 7 },
        reconciled: true,
        attached: true,
        cardAttempts: 1,
        announcement: { receipt: { nodeId: 'comment' }, code: undefined as string | undefined },
      };
      if (runtime === 'codex') issue.delivery = delivery;
      else issue.work!.delivery = delivery;
      assert.deepEqual(issueWorkflowProgress(issue), { action: 'complete', status: 'complete' });
      assert.equal(workflowStatus(issue), 'complete');
      if (runtime === 'codex') {
        issue.continuation!.head = 'new';
        assert.equal(issueWorkflowProgress(issue).action, 'delivery');
        issue.delivery!.pushedHead = 'new';
        assert.equal(issueWorkflowProgress(issue).action, 'complete');
      }

      delivery.announcement.code = 'delivery-announcement-unconfirmed';
      assert.deepEqual(issueWorkflowProgress(issue), {
        action: 'delivery',
        status: 'partially-delivered',
        publicationPending: false,
      });
      delivery.announcement.code = undefined;
      delivery.attached = false;
      assert.equal(issueWorkflowProgress(issue).action, 'delivery');
      delivery.attached = true;
      delivery.cardAttempts = 0;
      assert.equal(issueWorkflowProgress(issue).action, 'delivery');
      issue.retirement = {};
      assert.equal(issueWorkflowProgress(issue).action, 'stopped');
    });
    it(`should keep ${runtime} native denials authoritative even after implementation`, () => {
      const issue = record('done');
      if (runtime === 'codex') {
        issue.continuation!.phase = 'blocked';
        issue.continuation!.code = 'continuation-native-send-failed';
      } else issue.work!.code = 'dispatch-turn-cancelled';
      assert.deepEqual(issueWorkflowProgress(issue), { action: 'stopped', status: 'blocked' });
    });
  }
  it('should select assessment or unanswered assessment questions without assuming work authority', () => {
    assert.equal(
      issueWorkflowProgress({ phase: 'complete', result: { outcome: 'plan-ready' } }).action,
      'assessment',
    );
    assert.equal(
      issueWorkflowProgress({ phase: 'complete', result: { outcome: 'clarification-needed' } })
        .action,
      'wait-input',
    );
  });
  it('should require current completion receipts instead of trusting an old complete phase', () => {
    assert.deepEqual(
      issueWorkflowProgress({ phase: 'complete', continuation: { phase: 'complete' } }),
      { action: 'wait-input', status: 'result-missing' },
    );
  });
});
