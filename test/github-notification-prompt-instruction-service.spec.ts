import assert from 'node:assert/strict';

import GitHubNotificationPromptInstructionService from '../channels/github/lib/prompt-instruction-service.ts';

describe('channels/github/lib/prompt-instruction-service', () => {
  it('should stage one request before its correlated run begins', () => {
    const service = new GitHubNotificationPromptInstructionService({
      createRunId: () => 'notification-run',
    });
    const request = {
      assignmentKind: 'issue' as const,
      event: 'planning-request' as const,
      mode: 'plan' as const,
    };
    const run = service.prepare(request);

    assert.equal(run.runId, 'notification-run');
    assert.deepEqual(service.resolve(run.runId), request);

    run.clear();

    assert.equal(service.resolve(run.runId), undefined);
  });

  it('should isolate requests by run id and ignore absent cleanup', () => {
    const runIds = ['planning-run', 'comment-run'];
    const service = new GitHubNotificationPromptInstructionService({
      createRunId: () => runIds.shift() ?? 'unexpected-run',
    });
    const planning = service.prepare({
      assignmentKind: 'issue',
      event: 'planning-request',
      mode: 'plan',
    });
    const comment = service.prepare({
      assignmentKind: 'issue',
      event: 'comment-received',
      mode: 'plan',
    });

    service.clear(undefined);
    planning.clear();

    assert.equal(service.resolve(planning.runId), undefined);
    assert.deepEqual(service.resolve(comment.runId), {
      assignmentKind: 'issue',
      event: 'comment-received',
      mode: 'plan',
    });
  });
});
