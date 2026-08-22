import assert from 'node:assert/strict';

import isGitHubNotificationReplyToolContext from '../channels/github/publication/reply-tool-context.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';

const codexSessionKey =
  'agent:tanaabot:agent-system-github:tanaabot:direct:github:issue:r_repository:12';

describe('channels/github/publication/reply-tool-context', () => {
  it('should admit explicit github notification channel contexts', () => {
    assert.equal(
      isGitHubNotificationReplyToolContext({
        agentId: 'tanaabot',
        deliveryContext: { channel: githubNotificationChannelId },
        messageChannel: githubNotificationChannelId,
      }),
      true,
    );
    assert.equal(
      isGitHubNotificationReplyToolContext({
        agentId: 'tanaabot',
        messageChannel: githubNotificationChannelId,
        sessionKey: 'session-that-does-not-match-the-lifecycle-route',
      }),
      true,
    );
  });

  it('should admit the exact codex github issue session route when channels are absent', () => {
    assert.equal(
      isGitHubNotificationReplyToolContext({ agentId: 'Tanaabot', sessionKey: codexSessionKey }),
      true,
    );
  });

  it('should reject explicit channel conflicts without falling back to the session route', () => {
    assert.equal(
      isGitHubNotificationReplyToolContext({
        agentId: 'tanaabot',
        messageChannel: 'imessage',
        sessionKey: codexSessionKey,
      }),
      false,
    );
    assert.equal(
      isGitHubNotificationReplyToolContext({
        agentId: 'tanaabot',
        deliveryContext: { channel: 'imessage' },
        messageChannel: githubNotificationChannelId,
        sessionKey: codexSessionKey,
      }),
      false,
    );
  });

  it('should reject malformed or conflicting codex session routes', () => {
    const rejectedSessionKeys = [
      undefined,
      'sandbox-session',
      'agent:other:agent-system-github:tanaabot:direct:github:issue:r_repository:12',
      'agent:tanaabot:agent-system-github:other:direct:github:issue:r_repository:12',
      'agent:tanaabot:agent-system-github:tanaabot:direct:github:pull-request:r_repository:12',
      'agent:tanaabot:agent-system-github:tanaabot:direct:github:issue::12',
      'agent:tanaabot:agent-system-github:tanaabot:direct:github:issue:r_repository:0',
      'agent:tanaabot:agent-system-github:tanaabot:direct:github:issue:r_repository:12:extra',
    ];
    for (const sessionKey of rejectedSessionKeys) {
      assert.equal(
        isGitHubNotificationReplyToolContext({ agentId: 'tanaabot', sessionKey }),
        false,
        sessionKey ?? 'undefined session key',
      );
    }
  });
});
