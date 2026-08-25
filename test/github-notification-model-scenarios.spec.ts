import assert from 'node:assert/strict';

import resolveGitHubNotificationModelScenario, {
  githubNotificationModelScenarioIds,
} from '../scripts/github-notification-model-scenarios.ts';

describe('scripts/github-notification-model-scenarios', () => {
  it('should resolve the checked-in transitional scenario', () => {
    assert.deepEqual(githubNotificationModelScenarioIds, ['assignment-provider-proof']);

    const scenario = resolveGitHubNotificationModelScenario('assignment-provider-proof');
    assert.equal(scenario.id, 'assignment-provider-proof');
    assert.equal(scenario.fixtures.length, 2);
    const [toolCall] = scenario.toolCalls;
    assert.match(toolCall?.id ?? '', /^call_[A-Za-z0-9_-]{1,59}$/u);
    assert.deepEqual(scenario.toolCalls, [
      {
        id: toolCall?.id,
        name: 'agent_system_github_reply',
      },
    ]);
  });

  it('should reject an unknown scenario before starting the server', () => {
    assert.throws(
      () => resolveGitHubNotificationModelScenario('implementation'),
      /Unsupported GitHub notification model scenario: implementation/u,
    );
  });
});
