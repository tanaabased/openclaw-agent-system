import assert from 'node:assert/strict';

import { ModelRoutingError } from '../channels/github/conversation/model-routing.ts';
import { GitHubNotificationAssignmentOrchestratorError } from '../channels/github/intake/assignment-orchestrator.ts';
import { githubNotificationToolCauseCode } from '../channels/github/intake/monitor/diagnostic.ts';

describe('channels/github/intake/monitor/diagnostic', () => {
  it('should expose only a bounded llm cause code through nested assignment failures', () => {
    const denied = Object.assign(new Error('private operator policy details'), {
      code: 'LLM_COMPLETION_NOT_AUTHORIZED',
    });
    const routing = new ModelRoutingError(
      'github-notification-routing-classification-failed',
      'routing failed',
      { cause: denied },
    );
    const assignment = new GitHubNotificationAssignmentOrchestratorError(
      'github-notification-assignment-session-recording-failed',
      'assignment failed',
      { cause: routing },
    );

    assert.equal(githubNotificationToolCauseCode(assignment), 'LLM_COMPLETION_NOT_AUTHORIZED');
    assert.equal(
      githubNotificationToolCauseCode(
        new Error('outer', {
          cause: Object.assign(new Error('private'), { code: 'PRIVATE_RUNTIME_FAILURE' }),
        }),
      ),
      undefined,
    );
  });
});
