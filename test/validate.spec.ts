import assert from 'node:assert/strict';

import validateAgentSystem from '../cli/validate.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { createCliStyles } from '../cli/output.ts';
import { captureValidatePreview } from './validate-presentation-fixtures.ts';

const validResult: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot', name: 'Tanaabot' } },
  diagnostics: [],
  validationChecks: [],
};

function createHarness(
  options: {
    agentId?: string;
    agent?: AgentManifestLoadResult;
    json?: boolean;
    workspace?: AgentManifestLoadResult;
  } = {},
) {
  const diagnostics: string[] = [];
  const output: string[] = [];
  const calls = { agent: [] as string[], workspace: [] as string[] };
  const exitCodes: number[] = [];

  return {
    calls,
    diagnostics,
    exitCodes,
    output,
    run: () =>
      validateAgentSystem({
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        json: options.json ?? false,
        manifestService: {
          async loadForAgentId(agentId) {
            calls.agent.push(agentId);
            return options.agent ?? validResult;
          },
          async loadForCommandDirectory(workspaceDir) {
            calls.workspace.push(workspaceDir);
            return options.workspace ?? validResult;
          },
        },
        output: {
          writeStderr: (message) => diagnostics.push(message),
          writeStdout: (message) => output.push(message),
        },
        setExitCode: (code) => exitCodes.push(code),
        styles: createCliStyles({ NO_COLOR: '1' }),
        workspaceDir: '/current',
      }),
  };
}

describe('cli/validate', () => {
  it('should validate the nearest workspace with a human-readable table', async () => {
    const { calls, output, run } = createHarness();

    await run();

    assert.deepEqual(calls.workspace, ['/current']);
    assert.deepEqual(output, [
      'valid     manifest  agent system manifest for tanaabot\n\nagent               tanaabot\n\nmanifest            /workspace/agent.yaml\n\nworkspace           /workspace\n',
    ]);
  });

  it('should report setup metadata without serializing command text', async () => {
    const { output, diagnostics, run } = createHarness({
      json: true,
      workspace: {
        ...validResult,
        manifest: {
          ...validResult.manifest,
          setup: {
            steps: [
              {
                id: 'default',
                apply: {
                  kind: 'shell',
                  shell: 'sh',
                  script: 'echo private-command',
                  timeoutSeconds: 300,
                },
              },
            ],
          },
        },
        validationChecks: [
          {
            code: 'setup-declaration-valid',
            component: 'setup',
            status: 'valid',
            message: 'Setup declaration with 1 ordered steps',
          },
        ],
      },
    });
    await run();
    assert.equal(JSON.parse(output.join('')).checks[1].component, 'setup');
    assert.doesNotMatch(output.join('') + diagnostics.join(''), /private-command/u);
  });

  it('should validate an explicit agent workspace', async () => {
    const { calls, run } = createHarness({ agentId: 'tanaabot' });

    await run();

    assert.deepEqual(calls.agent, ['tanaabot']);
    assert.deepEqual(calls.workspace, []);
  });

  it('should present carried lifecycle validation checks', async () => {
    const { output, run } = createHarness({
      workspace: {
        ...validResult,
        validationChecks: [
          {
            code: 'agent-declaration-valid',
            component: 'agent',
            message: 'OpenClaw agent declaration',
            status: 'valid',
          },
          {
            code: 'path-projection-valid',
            component: 'path',
            message: 'Executable path projection',
            status: 'valid',
          },
          {
            code: 'github-config-valid',
            component: 'github',
            message: 'GitHub tool configuration',
            status: 'valid',
          },
        ],
      },
    });

    await run();

    assert.equal(output.join('').includes('valid     agent'), true);
    assert.equal(output.join('').includes('valid     path'), true);
    assert.equal(output.join('').includes('valid     github'), true);
  });

  it('should write the same checks as structured json', async () => {
    const { output, run } = createHarness({
      json: true,
      workspace: {
        ...validResult,
        validationChecks: [
          {
            code: 'agent-declaration-valid',
            component: 'agent',
            message: 'OpenClaw agent declaration',
            status: 'valid',
          },
        ],
      },
    });

    await run();

    const result = JSON.parse(output.join(''));
    assert.equal(result.status, 'valid');
    assert.deepEqual(result.checks, [
      {
        code: 'manifest-valid',
        component: 'manifest',
        message: 'Agent System manifest for tanaabot',
        status: 'valid',
      },
      {
        code: 'agent-declaration-valid',
        component: 'agent',
        message: 'OpenClaw agent declaration',
        status: 'valid',
      },
    ]);
  });

  it('should report an invalid manifest and set a failing exit code', async () => {
    const invalid: AgentManifestLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/current' },
      path: '/current/agent.yaml',
      diagnostics: [],
    };
    const { diagnostics, exitCodes, output, run } = createHarness({ workspace: invalid });

    await run();

    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(output, []);
    assert.match(diagnostics.join(''), /invalid Agent System manifest/u);
  });

  it('should provide fixture-backed valid, warning, invalid, and unmanaged previews', async () => {
    const valid = await captureValidatePreview({
      ...validResult,
      manifest: { ...validResult.manifest, agent: { id: 'Agent-Mixed' } },
      path: '/Workspaces/An-Illustrative-Workspace-With-A-Long-Path/agent.yaml',
      scope: { workspaceDir: '/Workspaces/An-Illustrative-Workspace-With-A-Long-Path' },
      validationChecks: [
        {
          code: 'agent-declaration-valid',
          component: 'agent',
          message: 'OpenClaw agent declaration',
          status: 'valid',
        },
      ],
    });
    assert.equal(valid.exitCode, 0);
    assert.match(valid.events[0]!.text, /Agent-Mixed/u);
    assert.match(valid.events[0]!.text, /workspace/u);
    assert.match(valid.events[0]!.text, /agent declaration/u);
    assert.equal((valid.events[0]!.text.match(/Agent-Mixed/gu) ?? []).length, 1);

    const warning = await captureValidatePreview({
      ...validResult,
      diagnostics: [
        {
          code: 'illustrative-warning',
          component: 'manifest',
          message: 'Optional field is absent.',
          severity: 'warning',
        },
      ],
    });
    assert.equal(warning.exitCode, 0);
    assert.match(warning.events.at(-1)!.text, /warning/u);
    assert.match(warning.events.at(-1)!.text, /illustrative-warning/u);

    const invalid = await captureValidatePreview({
      status: 'invalid',
      scope: { workspaceDir: '/fixture' },
      path: '/fixture/agent.yaml',
      diagnostics: [],
    });
    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.events.at(-1)!.text, /error/u);
    assert.match(invalid.events.at(-1)!.text, /invalid Agent System manifest/u);

    const unmanaged = await captureValidatePreview({
      status: 'unmanaged',
      scope: { workspaceDir: '/fixture' },
      diagnostics: [],
    });
    assert.equal(unmanaged.exitCode, 1);
    assert.match(unmanaged.events.at(-1)!.text, /no Agent System manifest found/u);
  });
});
