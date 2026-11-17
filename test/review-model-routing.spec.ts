import assert from 'node:assert/strict';

import reviewModelRouting from '../agent/models/review-model-routing.ts';
import type { ReviewRoutingContext } from '../channels/github/provider/review-routing-context.ts';
import type { AgentModelsConfiguration } from '../manifest/models-schema.ts';

const models: AgentModelsConfiguration = {
  default: { model: 'openai/default', effort: 'medium' },
  low: { model: 'openai/small', effort: 'medium' },
  medium: { model: 'openai/middle', effort: 'medium' },
  high: { model: 'openai/large', effort: 'high' },
};
const context: ReviewRoutingContext = {
  source: 'https://github.com/owner/repo/pull/2',
  linkedIssueStatus: 'unique',
  linkedIssue: {
    source: 'https://github.com/owner/repo/issues/1',
    title: 'change shared behavior',
    metadata: {
      complexity: { status: 'verified', source: 'native', value: 'high' },
      workSize: { status: 'missing', source: 'native' },
    },
  },
};

describe('agent/models/review-model-routing', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should preserve linked complexity and reviewer profiles in ${runtime}`, () => {
      const result = reviewModelRouting({
        models,
        runtime,
        manifestDigest: 'current',
        context,
        assessment: { complexity: 'high', reason: 'Cross-system invariants require review.' },
      });
      assert.ok('selection' in result);
      assert.deepEqual(result.selection, models.high);
      assert.equal(result.source, 'native');
      const metadataOnly = reviewModelRouting({
        models,
        runtime,
        manifestDigest: 'current',
        context,
        assessment: { complexity: 'unset', reason: 'No contrary scope evidence.' },
      });
      assert.ok('selection' in metadataOnly);
      assert.deepEqual(metadataOnly.selection, models.high);
      assert.throws(
        () =>
          reviewModelRouting({
            models,
            runtime,
            manifestDigest: 'current',
            context,
            assessment: { complexity: 'low', reason: 'The diff is short.' },
          }),
        /model-routing-metadata-conflict|contradicts/,
      );
    });

    it(`should honor explicit choices without borrowing the author's model in ${runtime}`, () => {
      const result = reviewModelRouting({
        models,
        runtime,
        manifestDigest: 'current',
        context,
        assessment: { complexity: 'high', reason: 'Shared boundary change.' },
        overrides: { model: 'openai/explicit', effort: 'medium' },
      });
      assert.ok('selection' in result);
      assert.deepEqual(result.selection, { model: 'openai/explicit', effort: 'medium' });
    });

    it(`should assess unlinked review content and use the default for uncertainty in ${runtime}`, () => {
      for (const linkedIssueStatus of ['missing', 'ambiguous', 'unavailable'] as const) {
        const result = reviewModelRouting({
          models,
          runtime,
          manifestDigest: 'current',
          context: { ...context, linkedIssueStatus },
          assessment: {
            complexity: 'low',
            reason: 'Localized behavior with established coverage.',
          },
        });
        assert.ok('selection' in result);
        assert.deepEqual(result.selection, models.low);
        assert.equal(result.source, 'assessed');
      }
      const result = reviewModelRouting({
        models,
        runtime,
        manifestDigest: 'current',
        context: { source: context.source, linkedIssueStatus: 'missing' },
        assessment: { complexity: 'unset', reason: 'Insufficient review context.' },
      });
      assert.ok('selection' in result);
      assert.deepEqual(result.selection, models.default);
      assert.equal(result.status, 'unresolved');
    });
  }
});
