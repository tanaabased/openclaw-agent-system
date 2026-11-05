import assert from 'node:assert/strict';

import applyFeedbackScans from '../agent/apply-feedback-scans.ts';
import feedbackDiscoveryOwner from '../agent/feedback-discovery-owner.ts';

describe('agent/apply-feedback-scans', () => {
  const owner = () => ({
    id: 'owner',
    feedback: { events: ['retained'] },
    result: { receipt: 'saved' },
  });
  it('should apply discovery only to the unchanged owner and preserve other results', () => {
    const record = owner();
    const feedback = { events: ['discovered'] };
    const scan = { id: record.id, before: feedbackDiscoveryOwner(record), feedback };
    assert.equal(applyFeedbackScans([record], [scan]), true);
    assert.deepEqual(record.feedback, feedback);
    assert.deepEqual(record.result, { receipt: 'saved' });
    assert.equal(applyFeedbackScans([record], [scan]), false);
  });
  it('should merge discovery while preserving independently advanced issue results', () => {
    const record = owner();
    const scan = {
      id: record.id,
      before: feedbackDiscoveryOwner(record),
      feedback: { events: ['stale'] },
    };
    record.result.receipt = 'newly-published';
    assert.equal(applyFeedbackScans([record], [scan]), true);
    assert.deepEqual(record.feedback.events, ['stale']);
    assert.equal(record.result.receipt, 'newly-published');
  });
  it('should reject a concurrent feedback change or a changed chat binding', () => {
    for (const field of ['feedback', 'threadId'] as const) {
      const record = { ...owner(), threadId: 'chat' };
      const scan = {
        id: record.id,
        before: feedbackDiscoveryOwner(record),
        feedback: { events: ['stale'] },
      };
      if (field === 'feedback') record.feedback.events.push('concurrent');
      else record.threadId = 'replacement';
      assert.equal(applyFeedbackScans([record], [scan]), false);
      assert.ok(!record.feedback.events.includes('stale'));
    }
  });
  for (const flag of ['retired', 'retirement', 'reset', 'supersededBy'])
    it(`should not apply discovery to a ${flag} owner even when its snapshot matches`, () => {
      const record = { ...owner(), [flag]: { at: 1 } };
      assert.equal(
        applyFeedbackScans(
          [record],
          [
            {
              id: record.id,
              before: feedbackDiscoveryOwner(record),
              feedback: { events: ['stale'] },
            },
          ],
        ),
        false,
      );
      assert.deepEqual(record.feedback.events, ['retained']);
    });
  it('should never attach a discovery snapshot to another owner', () => {
    const record = owner();
    assert.equal(
      applyFeedbackScans(
        [record],
        [
          {
            id: 'other',
            before: feedbackDiscoveryOwner(record),
            feedback: { events: ['other'] },
          },
        ],
      ),
      false,
    );
  });
});
