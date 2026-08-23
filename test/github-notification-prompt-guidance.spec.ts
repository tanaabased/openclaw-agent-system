import assert from 'node:assert/strict';

import githubNotificationPromptGuidance from '../channels/github/conversation/prompt-guidance.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import { createGitHubNotificationTurnContractResolver } from './github-notification-turn-fixtures.ts';

describe('channels/github/conversation/prompt-guidance', () => {
  it('should compose the selected issue work comment instructions for github turns', async () => {
    const turnContracts = createGitHubNotificationTurnContractResolver();
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
