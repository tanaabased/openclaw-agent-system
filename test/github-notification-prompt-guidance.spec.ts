import assert from 'node:assert/strict';

import githubNotificationPromptGuidance from '../channels/github/conversation/prompt-guidance.ts';
import GitHubNotificationTurnCatalog, {
  githubNotificationSupportedTurnIdentities,
} from '../channels/github/conversation/turn-catalog.ts';
import GitHubNotificationTurnContractResolver from '../channels/github/conversation/turn-contract.ts';
import githubNotificationAssignmentEvent from '../channels/github/events/assignment.ts';
import githubNotificationCommentEvent from '../channels/github/events/comment.ts';
import GitHubNotificationEventRegistry from '../channels/github/events/registry.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import GitHubNotificationModeRegistry from '../channels/github/modes/registry.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';

function resolver() {
  const events = new GitHubNotificationEventRegistry([
    githubNotificationAssignmentEvent,
    githubNotificationCommentEvent,
  ]);
  const lifecycles = new GitHubNotificationLifecycleRegistry([
    new GitHubIssueLifecycle({
      async inspectGitHub() {
        return undefined;
      },
      async prepareGitHub() {
        throw new Error('not used');
      },
    }),
  ]);
  const modes = new GitHubNotificationModeRegistry([githubNotificationWorkMode]);
  const turns = new GitHubNotificationTurnCatalog(githubNotificationSupportedTurnIdentities, {
    events,
    lifecycles,
    modes,
  });
  return new GitHubNotificationTurnContractResolver({ turns });
}

describe('channels/github/conversation/prompt-guidance', () => {
  it('should compose the selected issue work comment instructions for github turns', async () => {
    const turnContracts = resolver();
    const turnSelector = {
      async select() {
        return { eventId: 'comment', lifecycleId: 'issue', modeId: 'work' } as const;
      },
    };

    assert.equal(
      await githubNotificationPromptGuidance(
        { messageProvider: githubNotificationChannelId },
        { turnContracts, turnSelector },
      ),
      turnContracts.instructions({
        eventId: 'comment',
        lifecycleId: 'issue',
        modeId: 'work',
      }),
    );
    assert.equal(
      await githubNotificationPromptGuidance(
        { messageProvider: 'discord' },
        {
          turnContracts,
          turnSelector: {
            async select() {
              throw new Error('unrelated providers must not select a github turn');
            },
          },
        },
      ),
      undefined,
    );
  });

  it('should compose the identity returned by the trusted selector', async () => {
    let selectorContext: unknown;
    let selected: unknown;
    const context = {
      agentId: 'tanaabot',
      channelId: 'github:issue:R_repo:12',
      messageProvider: githubNotificationChannelId,
    };
    const instructions = await githubNotificationPromptGuidance(context, {
      turnContracts: {
        instructions(identity) {
          selected = identity;
          return 'current instructions';
        },
      },
      turnSelector: {
        async select(receivedContext) {
          selectorContext = receivedContext;
          return { eventId: 'comment', lifecycleId: 'issue', modeId: 'work' };
        },
      },
    });

    assert.equal(instructions, 'current instructions');
    assert.equal(selectorContext, context);
    assert.deepEqual(selected, {
      eventId: 'comment',
      lifecycleId: 'issue',
      modeId: 'work',
    });
  });
});
