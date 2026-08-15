import assert from 'node:assert/strict';

import githubNotificationCapabilityPolicy from '../channels/github/lib/message-capability-policy.ts';
import resolveGitHubNotificationMessage, {
  parseGitHubNotificationMessageRequest,
} from '../channels/github/lib/message-registry.ts';

describe('channels/github/lib/message-registry', () => {
  it('should select separate layers for planning and direct comments', () => {
    const planning = resolveGitHubNotificationMessage({
      assignmentKind: 'issue',
      event: 'planning-request',
      mode: 'plan',
    });
    const comment = resolveGitHubNotificationMessage({
      assignmentKind: 'pull-request',
      event: 'comment-received',
      mode: 'plan',
    });

    assert.deepEqual(
      {
        capability: planning.capability,
        context: planning.context,
        presentation: planning.presentation,
      },
      {
        capability: 'tool-free',
        context: 'issue-assignment',
        presentation: 'assignment-card',
      },
    );
    assert.match(planning.instructions ?? '', /Work in Plan mode/u);
    assert.deepEqual(
      {
        capability: comment.capability,
        context: comment.context,
        presentation: comment.presentation,
      },
      {
        capability: 'tool-free',
        context: 'comment',
        presentation: 'direct-comment',
      },
    );
    assert.match(comment.instructions ?? '', /## 📤 To GitHub/u);
  });

  it('should reject unsupported modes and malformed hook metadata', () => {
    assert.throws(
      () =>
        resolveGitHubNotificationMessage({
          assignmentKind: 'issue',
          event: 'planning-request',
          mode: 'work',
        }),
      /work messages are not implemented/u,
    );
    assert.equal(
      parseGitHubNotificationMessageRequest({
        assignmentKind: 'issue',
        event: 'planning-request',
        hidden: 'instructions',
        mode: 'plan',
      }),
      undefined,
    );
  });

  it('should enforce the selected tool-free capability independently from instructions', () => {
    assert.deepEqual(githubNotificationCapabilityPolicy('tool-free'), {
      disableTools: true,
      toolsAllow: [],
    });
    assert.throws(() => githubNotificationCapabilityPolicy('none'), /does not dispatch/u);
  });
});
