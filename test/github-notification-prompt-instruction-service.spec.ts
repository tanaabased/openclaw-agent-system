import assert from 'node:assert/strict';

import GitHubNotificationPromptInstructionService, {
  GitHubNotificationPromptInstructionServiceError,
  type GitHubNotificationPromptInstructionServiceDependencies,
} from '../channels/github/lib/prompt-instruction-service.ts';

type RunContext = GitHubNotificationPromptInstructionServiceDependencies['runContext'];

function createRunContext() {
  const values = new Map<string, unknown>();
  const key = (runId: string, namespace: string) => `${runId}:${namespace}`;
  const runContext: RunContext = {
    clearRunContext({ namespace, runId }) {
      values.delete(key(runId, namespace ?? ''));
    },
    getRunContext({ namespace, runId }) {
      return values.get(key(runId, namespace)) as never;
    },
    setRunContext({ namespace, runId, value }) {
      if (value === undefined) return false;
      values.set(key(runId, namespace), value);
      return true;
    },
  };
  return { runContext, values };
}

describe('channels/github/lib/prompt-instruction-service', () => {
  it('should retain one adopted request for the complete correlated run', () => {
    const { runContext, values } = createRunContext();
    const service = new GitHubNotificationPromptInstructionService({
      createRunId: () => 'notification-run',
      runContext,
    });
    const request = {
      assignmentKind: 'issue' as const,
      event: 'planning-request' as const,
      mode: 'plan' as const,
    };
    const run = service.prepare(request);

    assert.equal(run.runId, 'notification-run');
    assert.equal(service.resolve(run.runId), undefined);

    run.adopt();
    run.adopt();

    assert.deepEqual(service.resolve(run.runId), request);
    assert.equal(values.size, 1);

    run.clear();

    assert.equal(service.resolve(run.runId), undefined);
    assert.equal(values.size, 0);
  });

  it('should fail before dispatch when openclaw rejects the run context', () => {
    const service = new GitHubNotificationPromptInstructionService({
      createRunId: () => 'notification-run',
      runContext: {
        clearRunContext() {},
        getRunContext: () => undefined,
        setRunContext: () => false,
      },
    });
    const run = service.prepare({
      assignmentKind: 'issue',
      event: 'comment-received',
      mode: 'plan',
    });

    assert.throws(
      () => run.adopt(),
      (error: unknown) =>
        error instanceof GitHubNotificationPromptInstructionServiceError &&
        error.code === 'github-notification-instruction-context-unavailable',
    );
  });
});
