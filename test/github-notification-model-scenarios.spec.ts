import assert from 'node:assert/strict';

import resolveGitHubNotificationModelScenario, {
  githubNotificationModelScenarioIds,
} from '../scripts/github-notification-model-scenarios.ts';

describe('scripts/github-notification-model-scenarios', () => {
  it('should resolve the converted assignment and transitional proof scenarios', () => {
    assert.deepEqual(githubNotificationModelScenarioIds, [
      'assignment',
      'assignment-provider-proof',
    ]);

    const callIds = githubNotificationModelScenarioIds.map((scenarioId) => {
      const scenario = resolveGitHubNotificationModelScenario(scenarioId);
      assert.equal(scenario.id, scenarioId);
      assert.equal(scenario.fixtures.length, 2);
      const [toolCall] = scenario.toolCalls;
      assert.match(toolCall?.id ?? '', /^call_[A-Za-z0-9_-]{1,59}$/u);
      assert.deepEqual(scenario.toolCalls, [
        {
          id: toolCall?.id,
          name: 'agent_system_github_reply',
        },
      ]);
      return toolCall?.id;
    });
    assert.equal(new Set(callIds).size, callIds.length);
  });

  it('should reject an unknown scenario before starting the server', () => {
    assert.throws(
      () => resolveGitHubNotificationModelScenario('implementation'),
      /Unsupported GitHub notification model scenario: implementation/u,
    );
  });
});
