import assert from 'node:assert/strict';

import githubNotificationPromptGuidance from '../channels/github/conversation/prompt-guidance.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import { createGitHubNotificationTurnContractResolver } from './github-notification-turn-fixtures.ts';

describe('channels/github/conversation/prompt-guidance', () => {
  it('should compose the selected issue work comment instructions for github turns', async () => {
    const turnContracts = createGitHubNotificationTurnContractResolver();
    const selected = {
      agentId: 'tanaabot',
      conversationId: 'github:issue:R_repo:12',
      identity: { eventId: 'comment', lifecycleId: 'issue', modeId: 'work' } as const,
      sourceId: 'revision-1',
    };
    const attestations: unknown[] = [];
    const turnSelector = {
      async select() {
        return selected;
      },
    };

    assert.equal(
      await githubNotificationPromptGuidance(
        { messageProvider: githubNotificationChannelId },
        {
          candidates: {
            async attestPromptSelection(attestation) {
              attestations.push(attestation);
            },
          },
          turnContracts,
          turnSelector,
        },
      ),
      turnContracts.instructions(selected.identity),
    );
    assert.deepEqual(attestations, [selected]);
    assert.equal(
      await githubNotificationPromptGuidance(
        { messageProvider: 'discord' },
        {
          candidates: {
            async attestPromptSelection() {
              throw new Error('unrelated providers must not attest a github turn');
            },
          },
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

  it('should compose and attest the assignment identity returned by the trusted selector', async () => {
    const turnContracts = createGitHubNotificationTurnContractResolver();
    let selectorContext: unknown;
    let attested: unknown;
    const context = {
      agentId: 'tanaabot',
      channelId: 'github:issue:R_repo:12',
      messageProvider: githubNotificationChannelId,
    };
    const selected = {
      agentId: 'tanaabot',
      conversationId: 'github:issue:R_repo:12',
      identity: { eventId: 'assignment', lifecycleId: 'issue', modeId: 'work' } as const,
      sourceId: 'EV_assignment',
    };
    const instructions = await githubNotificationPromptGuidance(context, {
      candidates: {
        async attestPromptSelection(attestation) {
          attested = attestation;
        },
      },
      turnContracts,
      turnSelector: {
        async select(receivedContext) {
          selectorContext = receivedContext;
          return selected;
        },
      },
    });

    assert.equal(instructions, turnContracts.instructions(selected.identity));
    assert.equal(selectorContext, context);
    assert.deepEqual(attested, selected);
  });
});
