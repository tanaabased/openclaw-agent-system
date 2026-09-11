import assert from 'node:assert/strict';

import doctorAgentSystem from '../cli/doctor.ts';
import type { AgentDoctorResult } from '../agent/doctor-service.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { createCliStyles } from '../cli/output.ts';
import { doctorFindings } from './lifecycle-presentation-fixtures.ts';

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
  it('should group human findings without changing json, aggregate status, or diagnostics', async () => {
    const result: AgentDoctorResult = {
      agentId: 'data',
      findings: structuredClone(doctorFindings),
      status: 'blocked',
      workspaceDir: '/workspace',
    };
    const original = structuredClone(result);
    Object.freeze(result.findings);
    for (const json of [false, true]) {
      const output: string[] = [];
      const diagnostics: string[] = [];
      const exitCodes: number[] = [];
      const calls: unknown[] = [];
      const warnedManifest: AgentManifestLoadResult = {
        ...manifest,
        diagnostics: [
          { code: 'manifest-warning', message: 'Manifest warning.', severity: 'warning' },
        ],
      };
      await doctorAgentSystem({
        doctorService: {
          async inspect(input) {
            calls.push(input);
            return result;
          },
        },
        json,
        manifestService: {
          async loadForAgentId() {
            return warnedManifest;
          },
          async loadForCommandDirectory() {
            return warnedManifest;
          },
        },
        output: {
          writeStderr: (value) => diagnostics.push(value),
          writeStdout: (value) => output.push(value),
        },
        setExitCode: (code) => exitCodes.push(code),
        styles: createCliStyles(json ? { FORCE_COLOR: '3' } : { NO_COLOR: '1', FORCE_COLOR: '3' }),
        terminalColumns: 60,
        workspaceDir: '/workspace',
      });
      assert.deepEqual(calls, [{ manifest: manifest.manifest, workspaceDir: '/workspace' }]);
      assert.deepEqual(exitCodes, [1]);
      assert.equal(diagnostics.length, 1);
      assert.ok(diagnostics[0]!.includes('code=manifest-warning'));
      assert.equal(output.length, 1);
      const text = output.join('');
      assert.equal(text.includes('\u001b'), false);
      assert.equal(text.includes('manifest-warning'), false);
      if (json) {
        assert.equal(text, `${JSON.stringify(original, undefined, 2)}\n`);
        assert.deepEqual(JSON.parse(text), original);
      } else {
        const rows = text
          .split('\n')
          .filter((row) => /^\S+\s+(blocked|warning|drift|manual|healthy)\s/.test(row));
        assert.deepEqual(
          rows.map((row) => row.split(/\s+/).slice(0, 2)),
          [
            ['git', 'blocked'],
            ['github', 'blocked'],
            ['security', 'warning'],
            ['github-notifications', 'manual'],
            ['path', 'drift'],
            ['agent', 'healthy'],
            ['tool-access', 'healthy'],
          ],
        );
        for (const { message, remediation } of result.findings) {
          const normalized = text.replace(/\s+/g, ' ');
          assert.ok(normalized.includes(message));
          if (remediation) assert.ok(normalized.includes(remediation));
        }
      }
      assert.deepEqual(result, original);
    }
  });

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
