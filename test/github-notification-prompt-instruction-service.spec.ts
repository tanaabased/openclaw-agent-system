import assert from 'node:assert/strict';

import GitHubNotificationPromptInstructionService from '../channels/github/lib/prompt-instruction-service.ts';

describe('channels/github/lib/prompt-instruction-service', () => {
  it('should expose one hidden instruction only through its run id', () => {
    const service = new GitHubNotificationPromptInstructionService({
      createRunId: () => 'run-one',
    });
    const run = service.prepare('Hidden response contract.');

    assert.equal(run.runId, 'run-one');
    assert.equal(service.resolve('run-one'), 'Hidden response contract.');
    assert.equal(service.resolve('run-two'), undefined);
    run.clear();
    assert.equal(service.resolve('run-one'), undefined);
  });
});
