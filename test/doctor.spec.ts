import assert from 'node:assert/strict';

import { cliDiagnosticContext } from '../core/cli-diagnostic-context.ts';
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
  it('should show machine categories and masked thread details only in human output', async () => {
    const result: AgentDoctorResult = {
      agentId: 'data',
      workspaceDir: '/workspace',
      status: 'healthy',
      findings: [
        {
          component: 'automations',
          stepId: 'github-issue-assignment',
          code: 'automation-healthy',
          status: 'healthy',
          message:
            'Automation github-issue-assignment: healthy (persistent, reused: native-12345678).',
        },
      ],
    };
    for (const json of [false, true]) {
      const output: string[] = [];
      await doctorAgentSystem({
        doctorService: {
          async inspect() {
            return result;
          },
        },
        json,
        manifestService: {
          async loadForAgentId() {
            return manifest;
          },
          async loadForCommandDirectory() {
            return manifest;
          },
        },
        output: { writeStderr() {}, writeStdout: (value) => output.push(value) },
        setExitCode() {
          assert.fail('healthy fixture must not fail');
        },
        styles: createCliStyles({ NO_COLOR: '1' }),
        terminalColumns: 160,
        workspaceDir: '/workspace',
      });
      const text = output.join('');
      if (json) assert.deepEqual(JSON.parse(text), result);
      else {
        assert.match(text, /automation\s+healthy\s+name: ISSUE ASSIGNMENTS/u);
        assert.ok(text.includes('thread: ***5678'));
        assert.equal(text.includes('native-12345678'), false);
      }
    }
  });

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
      const events: string[] = [];
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
          writeStderr: (value) => {
            diagnostics.push(value);
            events.push('diagnostics');
          },
          writeStdout: (value) => {
            output.push(value);
            events.push('result');
          },
        },
        setExitCode: (code) => exitCodes.push(code),
        styles: createCliStyles(json ? { FORCE_COLOR: '3' } : { NO_COLOR: '1', FORCE_COLOR: '3' }),
        terminalColumns: 60,
        workspaceDir: '/workspace',
      });
      assert.deepEqual(calls, [
        { manifest: manifest.manifest, workspaceDir: '/workspace', runtime: 'openclaw' },
      ]);
      assert.deepEqual(exitCodes, [1]);
      assert.equal(diagnostics.length, 1);
      assert.deepEqual(events, ['result', 'diagnostics']);
      assert.ok(diagnostics[0]!.includes('code=manifest-warning'));
      assert.equal(output.length, 1);
      const text = output.join('');
      assert.equal(text.includes('\u001b'), false);
      assert.equal(text.includes('manifest-warning'), false);
      if (json) {
        assert.equal(text, `${JSON.stringify(original, undefined, 2)}\n`);
      } else {
        const rows = text
          .split('\n')
          .map((row) => row.trim())
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

  it('should retain a primary finding while coalescing repeated manifest observations', async () => {
    const diagnostic = {
      [cliDiagnosticContext]: {
        condition: { key: 'review-capability', component: 'github-intake', fieldPath: '/review' },
        remediation: ['disable reviews'],
      },
      component: 'github-intake',
      code: 'github-notification-runtime-unsupported',
      fieldPath: '/review',
      message: 'Reviews unavailable.',
      severity: 'warning' as const,
    };
    const result: AgentDoctorResult = {
      agentId: 'data',
      workspaceDir: '/workspace',
      status: 'healthy',
      findings: [
        {
          component: diagnostic.component,
          code: diagnostic.code,
          message: diagnostic.message,
          remediation: 'disable reviews',
          status: 'warning',
        },
      ],
    };
    for (const json of [false, true]) {
      const events: { stream: string; text: string }[] = [];
      let calls = 0;
      const loaded = { ...manifest, diagnostics: [diagnostic, diagnostic] };
      await doctorAgentSystem({
        json,
        workspaceDir: '/workspace',
        terminalColumns: 240,
        styles: createCliStyles({ NO_COLOR: '1' }),
        manifestService: {
          loadForAgentId: async () => loaded,
          loadForCommandDirectory: async () => loaded,
        },
        doctorService: {
          inspect: async () => {
            calls++;
            return result;
          },
        },
        output: {
          writeStdout: (text) => events.push({ stream: 'stdout', text }),
          writeStderr: (text) => events.push({ stream: 'stderr', text }),
        },
        setExitCode: () => assert.fail('non-blocking warning'),
      });
      assert.equal(calls, 1);
      assert.deepEqual(
        events.map(({ stream }) => stream),
        ['stdout', 'stderr'],
      );
      assert.equal(
        events[1]!.text.match(/code=github-notification-runtime-unsupported/gu)?.length,
        1,
      );
      assert.equal(events[1]!.text.match(/disable reviews/gu)?.length, 1);
      if (json) assert.equal(events[0]!.text, `${JSON.stringify(result, undefined, 2)}\n`);
      else assert.match(events[0]!.text, /Reviews unavailable[\s\S]*disable reviews/u);
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
