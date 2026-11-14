import assert from 'node:assert/strict';
import selectReplyDraft from '../agent/tasks/feedback/reply-selection.ts';
import type { ReplyDraft } from '../agent/tasks/feedback/reply-store.ts';
import workflowFailure from '../agent/tasks/workflow-failure.ts';
import { openClawDispatchFailureCode } from '../agent/tasks/dispatch/openclaw-dispatch-context.ts';

describe('agent/reply-selection', () => {
  it('should preserve a safe diagnostic when concurrent drafts require an authored choice', () => {
    const drafts = ['first', 'second'].map(
      (privateText) =>
        ({
          turnId: 'turn',
          inputId: 'input',
          privateText,
        }) as ReplyDraft,
    );
    assert.throws(
      () =>
        selectReplyDraft(drafts, { operation: 'candidate' }, { turnId: 'turn', inputId: 'input' }),
      (error: unknown) => {
        assert.equal(openClawDispatchFailureCode(error), 'reply-draft-selection-required');
        assert.equal(
          workflowFailure(error, 'dispatch-operation-failed').code,
          'reply-draft-selection-required',
        );
        return true;
      },
    );
    assert.equal(
      selectReplyDraft(
        drafts,
        { operation: 'candidate', privateText: 'second' },
        { turnId: 'turn', inputId: 'input' },
      ),
      drafts[1],
    );
    assert.equal(
      selectReplyDraft(drafts, { operation: 'context' }, { turnId: 'turn', inputId: 'input' }),
      undefined,
    );
  });
});
