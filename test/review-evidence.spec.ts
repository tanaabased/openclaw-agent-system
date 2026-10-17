import assert from 'node:assert/strict';

import {
  reviewEvidenceDigest,
  reviewTrigger,
  type ReviewEvidence,
} from '../channels/github/review-evidence.ts';

describe('channels/github/review-evidence', () => {
  const evidence: ReviewEvidence = {
    head: 'head-1',
    base: 'base-1',
    complete: true,
    checks: [{ id: 'run-1', attempt: 1, status: 'completed', conclusion: 'failure' }],
    feedback: [{ id: 'comment-1', revision: 'body-1' }],
    requests: [{ id: 'request-1', revision: 'requested' }],
  };
  const trigger = (current = evidence, extra = {}) =>
    reviewTrigger({
      current,
      open: true,
      authorized: true,
      running: false,
      processedDigest: reviewEvidenceDigest(evidence),
      ...extra,
    });
  it('should admit failed ci on the first pass and remain quiet after processing unchanged evidence', () => {
    assert.equal(trigger(evidence, { processedDigest: undefined }), 'dispatch');
    assert.equal(trigger(), 'unchanged');
  });
  it('should reactivate processed work on commits, same-head reruns, results and admitted feedback or requests', () => {
    for (const current of [
      { ...evidence, head: 'head-2' },
      { ...evidence, base: 'base-2' },
      { ...evidence, checks: [{ ...evidence.checks[0]!, attempt: 2 }] },
      { ...evidence, checks: [{ ...evidence.checks[0]!, conclusion: 'success' }] },
      { ...evidence, feedback: [{ id: 'comment-1', revision: 'body-2' }] },
      { ...evidence, requests: [{ id: 'request-2', revision: 'requested' }] },
    ]) {
      assert.equal(trigger(current), 'dispatch');
      assert.equal(trigger(current, { running: true }), 'pending');
    }
  });
  it('should never call incomplete evidence, closure or lost authority a completed review', () => {
    assert.equal(trigger({ ...evidence, complete: false }), 'evidence-unavailable');
    assert.equal(trigger(evidence, { open: false }), 'closed');
    assert.equal(trigger(evidence, { authorized: false }), 'unauthorized');
  });
  it('should ignore ordering while rejecting ambiguous evidence identities', () => {
    const current = {
      ...evidence,
      feedback: [...evidence.feedback, { id: 'comment-2', revision: 'body-2' }],
    };
    assert.equal(
      reviewEvidenceDigest(current),
      reviewEvidenceDigest({ ...current, feedback: [...current.feedback].reverse() }),
    );
    assert.throws(
      () => reviewEvidenceDigest({ ...evidence, checks: [...evidence.checks, ...evidence.checks] }),
      /review-evidence-duplicate/,
    );
  });
});
