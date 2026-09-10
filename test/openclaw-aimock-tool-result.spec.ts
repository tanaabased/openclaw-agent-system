import assert from 'node:assert/strict';

import { githubNotificationAssignmentCallId } from '../scenarios/issue-work-assignment/model-fixture.ts';
import hasOpenClawAIMockToolResult, {
  matchesOpenClawAIMockToolCallId,
  openClawAIMockToolResultText,
} from '../scripts/aimock-tool-result.ts';

describe('scripts/aimock-tool-result', () => {
  it('should recognize only the requested scenario tool result', () => {
    assert.equal(
      hasOpenClawAIMockToolResult(
        [{ role: 'assistant' }, { role: 'tool', tool_call_id: githubNotificationAssignmentCallId }],
        githubNotificationAssignmentCallId,
      ),
      true,
    );
    assert.equal(
      hasOpenClawAIMockToolResult(
        [
          {
            role: 'tool',
            tool_call_id: `${githubNotificationAssignmentCallId}_fc-observed_123`,
          },
        ],
        githubNotificationAssignmentCallId,
      ),
      true,
    );
    assert.equal(
      hasOpenClawAIMockToolResult(
        [{ role: 'tool', tool_call_id: 'call_other' }],
        githubNotificationAssignmentCallId,
      ),
      false,
    );
  });

  it('should reject unrelated suffixes that merely share the authored prefix', () => {
    assert.equal(
      matchesOpenClawAIMockToolCallId(
        `${githubNotificationAssignmentCallId}_fc-observed_123`,
        githubNotificationAssignmentCallId,
      ),
      true,
    );
    assert.equal(
      matchesOpenClawAIMockToolCallId(
        `${githubNotificationAssignmentCallId}_message-observed`,
        githubNotificationAssignmentCallId,
      ),
      false,
    );
  });

  it('should return text only for the requested tool result', () => {
    assert.equal(
      openClawAIMockToolResultText(
        [
          { content: 'other', role: 'tool', tool_call_id: 'call_other' },
          {
            content: [{ text: '{"login":"emoriwan"}' }],
            role: 'tool',
            tool_call_id: `${githubNotificationAssignmentCallId}_fc-observed_123`,
          },
        ],
        githubNotificationAssignmentCallId,
      ),
      '{"login":"emoriwan"}',
    );
  });
});
