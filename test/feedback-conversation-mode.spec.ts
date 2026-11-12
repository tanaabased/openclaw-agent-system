import assert from 'node:assert/strict';

import { feedbackConversationMode } from '../agent/tasks/feedback/feedback-conversation-mode.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('agent/feedback-conversation-mode', () => {
  it('should preserve an explicit manual plan mode while using the shared feedback transition', () => {
    const policy = intakeFixture().policy;
    const record = { manualIssue: { selections: { mode: 'plan' as const } } };
    assert.equal(
      feedbackConversationMode(record, {
        ...policy,
        issueAssignment: { ...policy.issueAssignment!, mode: 'work' },
      }),
      'plan',
    );
    assert.equal(
      feedbackConversationMode(
        { ...record, progression: { stage: 'implementation', via: 'operator' } },
        policy,
      ),
      'work',
    );
  });
});
