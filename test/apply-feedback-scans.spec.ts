import assert from 'node:assert/strict';

import applyFeedbackScans from '../agent/apply-feedback-scans.ts';
import { automationHash } from '../agent/automation-hash.ts';

describe('agent/apply-feedback-scans', () => {
  const owner = () => ({
    id: 'owner',
    feedback: { events: ['retained'] },
    result: { receipt: 'saved' },
  });
  it('should apply discovery only to the unchanged owner and preserve other results', () => {
    const record = owner();
    const feedback = { events: ['discovered'] };
    const scan = { id: record.id, before: automationHash(record), feedback };
    assert.equal(applyFeedbackScans([record], [scan]), true);
    assert.deepEqual(record.feedback, feedback);
    assert.deepEqual(record.result, { receipt: 'saved' });
    assert.equal(applyFeedbackScans([record], [scan]), false);
  });
  it('should preserve a concurrently published receipt instead of replacing it with a stale scan', () => {
    const record = owner();
    const scan = { id: record.id, before: automationHash(record), feedback: { events: ['stale'] } };
    record.result.receipt = 'newly-published';
    assert.equal(applyFeedbackScans([record], [scan]), false);
    assert.deepEqual(record.feedback.events, ['retained']);
    assert.equal(record.result.receipt, 'newly-published');
  });
  for (const flag of ['retired', 'retirement', 'reset'])
    it(`should not apply discovery to a ${flag} owner even when its snapshot matches`, () => {
      const record = { ...owner(), [flag]: { at: 1 } };
      assert.equal(
        applyFeedbackScans(
          [record],
          [
            {
              id: record.id,
              before: automationHash(record),
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
            before: automationHash(record),
            feedback: { events: ['other'] },
          },
        ],
      ),
      false,
    );
  });
});
