import assert from 'node:assert/strict';
import dispatchContext, { dispatchEvidence } from '../agent/dispatch-context.ts';

describe('dispatch evidence', () => {
  const source = 'https://github.com/owner/repo/issues/3';
  const context = dispatchContext(
    { title: 'issue', body: 'requirements', labels: ['b', 'a'], comments: [], truncated: false },
    source,
    1,
  );
  it('should ignore receipt-bound output and label ordering without ignoring other comments', () => {
    const summary = {
      url: source + '#issuecomment-7',
      authorLogin: 'agent',
      body: 'summary',
      createdAt: '2026-10-01',
    };
    const own = new Set([summary.url]);
    assert.deepEqual(
      dispatchEvidence({ ...context, observedAt: 2, labels: ['a', 'b'], comments: [summary] }, own),
      dispatchEvidence(context),
    );
    assert.notDeepEqual(
      dispatchEvidence(
        { ...context, comments: [{ ...summary, url: source + '#issuecomment-8' }] },
        own,
      ),
      dispatchEvidence(context),
    );
    assert.notDeepEqual(
      dispatchEvidence({ ...context, body: 'new requirements' }, own),
      dispatchEvidence(context),
    );
    assert.notDeepEqual(
      dispatchEvidence({ ...context, truncated: true }, own),
      dispatchEvidence(context),
    );
  });
});
