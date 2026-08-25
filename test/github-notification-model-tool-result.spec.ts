import assert from 'node:assert/strict';

import hasGitHubNotificationModelToolResult from '../scripts/github-notification-model-tool-result.ts';
import { githubNotificationAssignmentCallId } from '../scenarios/issue-work-assignment/model-fixture.ts';

describe('scripts/github-notification-model-tool-result', () => {
  it('should recognize only the requested scenario tool result', () => {
    assert.equal(
      hasGitHubNotificationModelToolResult(
        [{ role: 'assistant' }, { role: 'tool', tool_call_id: githubNotificationAssignmentCallId }],
        githubNotificationAssignmentCallId,
      ),
      true,
    );
    assert.equal(
      hasGitHubNotificationModelToolResult(
        [{ role: 'tool', tool_call_id: 'call_other' }],
        githubNotificationAssignmentCallId,
      ),
      false,
    );
  });
});
