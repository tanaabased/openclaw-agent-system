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
  return new GitHubNotificationTurnContractResolver({ events, lifecycles, modes, turns });
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

  it('should keep the compatibility selector fixed to the current turn', () => {
    let selected: unknown;
    const instructions = githubNotificationPromptGuidance(
      { messageProvider: githubNotificationChannelId },
      {
        turnContracts: {
          instructions(identity) {
            selected = identity;
            return 'current instructions';
          },
        },
      },
    );

    assert.equal(instructions, 'current instructions');
    assert.deepEqual(selected, {
      eventId: 'comment',
      lifecycleId: 'issue',
      modeId: 'work',
    });
  });
});
