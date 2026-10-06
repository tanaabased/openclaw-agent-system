import assert from 'node:assert/strict';

import waitNotificationsAgentSystem from '../channels/github/cli/wait.ts';
import type { GitHubNotificationWaitInput } from '../channels/github/intake/monitor/status-service.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

const manifest: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot' } },
  diagnostics: [],
  validationChecks: [],
};

describe('channels/github/cli/wait', () => {
  for (const timeoutSeconds of ['1', '2147483', '2147484']) {
    it(`should validate timeout ${timeoutSeconds} before loading the manifest or waiting`, async () => {
      const calls: GitHubNotificationWaitInput[] = [];
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCodes: number[] = [];
      let loads = 0;
      const load = async () => {
        loads += 1;
        return manifest;
      };

      await waitNotificationsAgentSystem({
        json: true,
        manifestService: { loadForAgentId: load, loadForCommandDirectory: load },
        output: {
          writeStdout: (value) => stdout.push(value),
          writeStderr: (value) => stderr.push(value),
        },
        refresh: false,
        setExitCode: (code) => exitCodes.push(code),
        statusService: {
          async wait(input) {
            calls.push(input);
            return {
              agentId: input.agentId,
              code: 'github-notification-baseline-ready',
              observation: {
                agentId: input.agentId,
                baseline: { status: 'ready' },
                capacity: { active: 0, limit: 2, queued: 0 },
                code: 'github-notification-status-ready',
                items: [],
                schemaVersion: 2,
                status: 'ready',
              },
              schemaVersion: 2,
              status: 'completed',
              target: input.target,
            };
          },
        },
        target: 'baseline-ready',
        timeoutSeconds,
        workspaceDir: '/workspace',
      });

      if (timeoutSeconds === '2147484') {
        assert.equal(loads, 0);
        assert.deepEqual(calls, []);
        assert.deepEqual(stdout, []);
        assert.match(stderr.join(''), /github-notification-wait-options-invalid/u);
        assert.deepEqual(exitCodes, [2]);
      } else {
        assert.equal(loads, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.timeoutMs, Number(timeoutSeconds) * 1_000);
        assert.equal(JSON.parse(stdout.join('')).status, 'completed');
        assert.deepEqual(stderr, []);
        assert.deepEqual(exitCodes, []);
      }
    });
  }
});
