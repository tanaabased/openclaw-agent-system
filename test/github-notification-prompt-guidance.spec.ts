import assert from 'node:assert/strict';

import githubNotificationPromptGuidance from '../channels/github/conversation/prompt-guidance.ts';
import GitHubNotificationTurnContractResolver from '../channels/github/conversation/turn-contract.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import GitHubNotificationModeRegistry from '../channels/github/modes/registry.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';

function resolver() {
  return new GitHubNotificationTurnContractResolver({
    lifecycles: new GitHubNotificationLifecycleRegistry([
      new GitHubIssueLifecycle({
        async inspectGitHub() {
          return undefined;
        },
        async prepareGitHub() {
          throw new Error('not used');
        },
      }),
    ]),
    modes: new GitHubNotificationModeRegistry([githubNotificationWorkMode]),
  });
}

describe('channels/github/conversation/prompt-guidance', () => {
  it('should compose the current issue work comment instructions for github turns', () => {
    const turnContracts = resolver();

    assert.equal(
      githubNotificationPromptGuidance(
        { messageProvider: githubNotificationChannelId },
        { turnContracts },
      ),
      turnContracts.instructions({
        eventId: 'comment',
        lifecycleId: 'issue',
        modeId: 'work',
      }),
    );
    assert.equal(
      githubNotificationPromptGuidance({ messageProvider: 'discord' }, { turnContracts }),
      undefined,
    );
  });
});
