import assert from 'node:assert/strict';

import refreshNotificationsAgentSystem from '../channels/github/cli/refresh.ts';
import type { GitHubNotificationMonitorRunOptions } from '../channels/github/intake/monitor/service.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';

const manifest: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot' } },
  diagnostics: [],
  validationChecks: [],
};

function createOutput() {
  const stderr: string[] = [];
  const stdout: string[] = [];
  return {
    output: {
      writeStderr: (value: string) => stderr.push(value),
      writeStdout: (value: string) => stdout.push(value),
    },
    stderr,
    stdout,
  };
}

describe('channels/github/cli/refresh', () => {
  it('should mark the refresh as one-shot and write one json result', async () => {
    const calls: GitHubNotificationMonitorRunOptions[] = [];
    const test = createOutput();

    await refreshNotificationsAgentSystem({
      json: true,
      manifestService: {
        loadForAgentId: async () => manifest,
        loadForCommandDirectory: async () => manifest,
      },
      monitorService: {
        async runOnce(options = {}) {
          assert.equal('aborted' in options, false);
          if (!('aborted' in options)) calls.push(options);
          return [
            {
              agentId: 'tanaabot',
              code: 'github-notification-poll-complete',
              status: 'completed',
            },
          ];
        },
      },
      output: test.output,
      setExitCode() {},
      workspaceDir: '/workspace',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.executionSurface, 'cli-one-shot');
    assert.equal(calls[0]?.signal instanceof AbortSignal, true);
    assert.equal(calls[0]?.waitForLeaseMs, 120_000);
    assert.equal(JSON.parse(test.stdout.join('')).code, 'github-notification-poll-complete');
    assert.deepEqual(test.stderr, []);
  });

  it('should keep unexpected refresh failures out of json stdout', async () => {
    const test = createOutput();
    const exitCodes: number[] = [];

    await refreshNotificationsAgentSystem({
      json: true,
      manifestService: {
        loadForAgentId: async () => manifest,
        loadForCommandDirectory: async () => manifest,
      },
      monitorService: {
        async runOnce() {
          throw new Error('refresh failed');
        },
      },
      output: test.output,
      setExitCode: (code) => exitCodes.push(code),
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.stdout, []);
    assert.match(test.stderr.join(''), /github-notification-refresh-failed/u);
    assert.deepEqual(exitCodes, [1]);
  });

  it('should reject an invalid timeout before starting a refresh', async () => {
    const test = createOutput();
    const exitCodes: number[] = [];
    let refreshes = 0;

    await refreshNotificationsAgentSystem({
      json: true,
      manifestService: {
        loadForAgentId: async () => manifest,
        loadForCommandDirectory: async () => manifest,
      },
      monitorService: {
        async runOnce() {
          refreshes += 1;
          return [];
        },
      },
      output: test.output,
      setExitCode: (code) => exitCodes.push(code),
      timeoutSeconds: '0',
      workspaceDir: '/workspace',
    });

    assert.equal(refreshes, 0);
    assert.deepEqual(test.stdout, []);
    assert.match(test.stderr.join(''), /github-notification-refresh-options-invalid/u);
    assert.deepEqual(exitCodes, [2]);
  });
});
