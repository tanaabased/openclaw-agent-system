import assert from 'node:assert/strict';

import doctorAgentSystem from '../cli/doctor.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import { createCliStyles } from '../lib/cli-output.ts';

const manifest: AgentManifestLoadResult = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'data', name: 'Data' } },
  diagnostics: [],
  validationChecks: [],
};

describe('cli/doctor', () => {
  it('should report path drift and set a failing exit code', async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];
    const commandDirectories: string[] = [];

    await doctorAgentSystem({
      doctorService: {
        async inspect() {
          return {
            agentId: 'data',
            findings: [
              {
                code: 'openclaw-exec-path-drift',
                component: 'path',
                message: 'OpenClaw exec path drifted.',
                remediation: 'Run openclaw agent-system install from this workspace.',
                status: 'drift',
              },
            ],
            status: 'drift',
            workspaceDir: '/workspace',
          };
        },
      },
      json: false,
      manifestService: {
        async loadForAgentId() {
          return manifest;
        },
        async loadForCommandDirectory(commandDirectory) {
          commandDirectories.push(commandDirectory);
          return manifest;
        },
      },
      output: { writeStderr() {}, writeStdout: (message) => output.push(message) },
      setExitCode: (code) => exitCodes.push(code),
      styles: createCliStyles({ NO_COLOR: '1' }),
      workspaceDir: '/workspace/project',
    });

    assert.deepEqual(commandDirectories, ['/workspace/project']);
    assert.deepEqual(exitCodes, [1]);
    assert.equal(output.join('').includes('Run openclaw agent-system install'), true);
  });

  it('should keep json output structured for a healthy manual config', async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];

    await doctorAgentSystem({
      doctorService: {
        async inspect() {
          return {
            agentId: 'data',
            findings: [
              {
                code: 'codex-config-manual',
                component: 'path',
                message: 'Codex workspace configuration is user-managed.',
                status: 'manual',
              },
            ],
            status: 'healthy',
            workspaceDir: '/workspace',
          };
        },
      },
      json: true,
      manifestService: {
        async loadForAgentId() {
          return manifest;
        },
        async loadForCommandDirectory() {
          return manifest;
        },
      },
      output: { writeStderr() {}, writeStdout: (message) => output.push(message) },
      setExitCode: (code) => exitCodes.push(code),
      styles: createCliStyles({ NO_COLOR: '1' }),
      workspaceDir: '/workspace',
    });

    assert.equal(JSON.parse(output.join('')).status, 'healthy');
    assert.deepEqual(exitCodes, []);
  });
});
