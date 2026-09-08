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
          logger: { warn() {} },
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
          logger: { warn() {} },
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
      logger: { warn() {} },
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

  it('should compose and attest the private implementation identity', async () => {
    const turnContracts = createGitHubNotificationTurnContractResolver();
    const selected = {
      agentId: 'tanaabot',
      conversationId: 'github:issue:R_repo:12',
      identity: { eventId: 'implementation', lifecycleId: 'issue', modeId: 'work' } as const,
      sourceId: 'EV_assignment',
    };
    const attestations: unknown[] = [];

    const instructions = await githubNotificationPromptGuidance(
      { messageProvider: githubNotificationChannelId },
      {
        candidates: {
          async attestPromptSelection(attestation) {
            attestations.push(attestation);
          },
        },
        logger: { warn() {} },
        turnContracts,
        turnSelector: { select: async () => selected },
      },
    );

    assert.equal(instructions, turnContracts.instructions(selected.identity));
    assert.match(instructions ?? '', /Carry out that plan now/u);
    assert.deepEqual(attestations, [selected]);
  });

  it('should recognize the authoritative channel and account-scoped session route', async () => {
    const turnContracts = createGitHubNotificationTurnContractResolver();
    const selected = {
      agentId: 'tanaabot',
      conversationId: 'github:issue:R_repo:12',
      identity: { eventId: 'assignment', lifecycleId: 'issue', modeId: 'work' } as const,
      sourceId: 'EV_assignment',
    };
    let selections = 0;
    let attestations = 0;
    const dependencies = {
      candidates: {
        async attestPromptSelection() {
          attestations += 1;
        },
      },
      logger: { warn() {} },
      turnContracts,
      turnSelector: {
        async select() {
          selections += 1;
          return selected;
        },
      },
    };

    assert.equal(
      await githubNotificationPromptGuidance(
        { channel: githubNotificationChannelId, messageProvider: 'github' },
        dependencies,
      ),
      turnContracts.instructions(selected.identity),
    );
    assert.equal(
      await githubNotificationPromptGuidance(
        {
          sessionKey: 'agent:tanaabot:agent-system-github:tanaabot:direct:github:issue:r_repo:12',
        },
        dependencies,
      ),
      turnContracts.instructions(selected.identity),
    );
    assert.equal(selections, 2);
    assert.equal(attestations, 2);
  });

  it('should report a value-free diagnostic for an unresolved github turn', async () => {
    const warnings: string[] = [];

    assert.equal(
      await githubNotificationPromptGuidance(
        { channel: githubNotificationChannelId },
        {
          candidates: {
            async attestPromptSelection() {
              throw new Error('unresolved turns must not be attested');
            },
          },
          logger: { warn: (message) => warnings.push(message) },
          turnContracts: createGitHubNotificationTurnContractResolver(),
          turnSelector: { select: async () => undefined },
        },
      ),
      undefined,
    );
    assert.deepEqual(warnings, [
      'github-notifications: prompt guidance unavailable code=github-notification-prompt-turn-unresolved',
    ]);
  });
});
