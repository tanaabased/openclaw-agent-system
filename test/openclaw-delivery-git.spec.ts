import assert from 'node:assert/strict';

import executeOpenClawDeliveryGit from '../core/openclaw-delivery-git.ts';
import workflowFailure from '../agent/workflow-failure.ts';
import { createGitToolDefinition } from '../tools/git/tool.ts';
import type AgentSystemToolRuntime from '../api/runtime.ts';

// the native runtime owns binding and redaction; delivery must not erase its failure evidence.
describe('core/openclaw-delivery-git', () => {
  it('should preserve bounded git authentication transport and permission evidence', async () => {
    for (const [stderr, classification] of [
      ['git@github.com: Permission denied (publickey). token=SECRET', 'authentication'],
      ['Connection reset by peer', 'transport'],
      ['remote: not allowed to push', 'permission'],
    ]) {
      await assert.rejects(
        executeOpenClawDeliveryGit({
          runtime: {
            executeCli: async () => ({
              auditId: 'fixture',
              kind: 'cli',
              operation: { action: 'push', risk: 'write', summary: 'Push task branch.' },
              commandResult: {
                exitCode: 128,
                stdout: '',
                stderr: stderr!,
                truncated: false,
                timedOut: false,
              },
              output: {
                exitCode: 128,
                stdout: '',
                stderr: stderr!,
                truncated: false,
                timedOut: false,
              },
            }),
          } as Pick<AgentSystemToolRuntime, 'executeCli'>,
          definition: createGitToolDefinition(),
          agentId: 'receiver',
          worktree: '/synthetic/worktree',
          caller: { sessionKey: 'agent:receiver:issue', sessionId: 'session' },
          argv: ['push', 'origin', 'task'],
          signal: new AbortController().signal,
        }),
        (error: unknown) => {
          const failure = workflowFailure(error, 'unknown');
          assert.equal(failure.code, 'delivery-git-operation-failed');
          assert.equal(failure.providerDiagnostic?.classification, classification);
          assert.doesNotMatch(JSON.stringify(failure), /SECRET/u);
          return true;
        },
      );
    }
  });
});
