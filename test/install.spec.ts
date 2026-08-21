import assert from 'node:assert/strict';

import installAgentSystem from '../cli/install.ts';
import type { AgentInstallResult } from '../lib/agent-install-service.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import { createCliStyles } from '../lib/cli-output.ts';
import { AgentSystemLifecycleError } from '../lib/lifecycle-registry.ts';

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
    install?: AgentInstallResult | Error;
    json?: boolean;
    manifest?: AgentManifestLoadResult;
  } = {},
) {
  const diagnostics: string[] = [];
  const output: string[] = [];
  const calls = {
    install: [] as Array<{ manifest: unknown; workspaceDir: string }>,
    workspace: [] as string[],
  };
  const exitCodes: number[] = [];

  return {
    calls,
    diagnostics,
    exitCodes,
    output,
    run: () =>
      installAgentSystem({
        installService: {
          async install(input) {
            calls.install.push(input);
            if (options.install instanceof Error) throw options.install;
            return (
              options.install ?? {
                outcomes: [
                  {
                    code: 'add-agent',
                    component: 'agent',
                    message: 'OpenClaw agent tanaabot',
                    status: 'created',
                  },
                  {
                    code: 'set-identity',
                    component: 'agent',
                    message: 'OpenClaw identity for tanaabot',
                    status: 'updated',
                  },
                ],
                agentId: 'tanaabot',
                warnings: [],
                workspaceDir: '/workspace',
              }
            );
          },
        },
        json: options.json ?? false,
        manifestService: {
          async loadForCommandDirectory(workspaceDir) {
            calls.workspace.push(workspaceDir);
            return options.manifest ?? validResult;
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

describe('cli/install', () => {
  it('should install a loaded workspace manifest and report completed outcomes', async () => {
    const { calls, output, run } = createHarness({
      install: {
        outcomes: [
          {
            code: 'add-agent',
            component: 'agent',
            message: 'OpenClaw agent tanaabot',
            status: 'created',
          },
          {
            code: 'set-identity',
            component: 'agent',
            message: 'OpenClaw identity for tanaabot',
            status: 'updated',
          },
          {
            code: 'create-workspace-bin',
            component: 'path',
            message: 'workspace bin directory',
            status: 'created',
          },
          {
            code: 'set-exec-path',
            component: 'path',
            message: 'OpenClaw exec path for tanaabot',
            status: 'updated',
          },
          {
            code: 'create-codex-config',
            component: 'path',
            message: 'Codex workspace path configuration',
            status: 'created',
          },
          {
            code: 'update-gitignore',
            component: 'path',
            message: 'workspace .gitignore',
            status: 'updated',
          },
          {
            code: 'create-github-config',
            component: 'github',
            message: 'private GitHub CLI config',
            status: 'created',
          },
        ],
        agentId: 'tanaabot',
        warnings: [],
        workspaceDir: '/workspace',
      },
    });

    await run();

    assert.deepEqual(calls.workspace, ['/current']);
    assert.deepEqual(calls.install, [
      { manifest: validResult.manifest, workspaceDir: '/workspace' },
    ]);
    assert.deepEqual(output, [
      'created    agent   OpenClaw agent tanaabot\nupdated    agent   OpenClaw identity for tanaabot\ncreated    path    workspace bin directory\nupdated    path    OpenClaw exec path for tanaabot\ncreated    path    Codex workspace path configuration\nupdated    path    workspace .gitignore\ncreated    github  private GitHub CLI config\nworkspace          /workspace\n',
    ]);
  });

  it('should warn without styling a user-managed codex configuration', async () => {
    const { diagnostics, run } = createHarness({
      install: {
        outcomes: [
          {
            code: 'path-unchanged',
            component: 'path',
            message: 'Executable path projection for tanaabot',
            status: 'unchanged',
          },
        ],
        agentId: 'tanaabot',
        warnings: [
          {
            code: 'codex-config-user-managed',
            component: 'path',
            message: 'The existing .codex/config.toml is user-managed.',
          },
        ],
        workspaceDir: '/workspace',
      },
    });

    await run();

    assert.deepEqual(diagnostics, [
      'path: The existing .codex/config.toml is user-managed. code=codex-config-user-managed\n',
    ]);
  });

  it('should report explicit unchanged outcomes for every component', async () => {
    const { output, run } = createHarness({
      install: {
        outcomes: [
          {
            code: 'agent-unchanged',
            component: 'agent',
            message: 'OpenClaw registration and identity for tanaabot',
            status: 'unchanged',
          },
          {
            code: 'path-unchanged',
            component: 'path',
            message: 'Executable path projection for tanaabot',
            status: 'unchanged',
          },
          {
            code: 'github-config-unchanged',
            component: 'github',
            message: 'private GitHub CLI config',
            status: 'unchanged',
          },
        ],
        agentId: 'tanaabot',
        warnings: [],
        workspaceDir: '/workspace',
      },
    });

    await run();

    assert.deepEqual(output, [
      'unchanged  agent   OpenClaw registration and identity for tanaabot\nunchanged  path    Executable path projection for tanaabot\nunchanged  github  private GitHub CLI config\nworkspace          /workspace\n',
    ]);
  });

  it('should write structured json from the same install result', async () => {
    const { output, run } = createHarness({
      json: true,
      install: {
        outcomes: [
          {
            code: 'agent-unchanged',
            component: 'agent',
            message: 'OpenClaw registration and identity for tanaabot',
            status: 'unchanged',
          },
        ],
        agentId: 'tanaabot',
        warnings: [],
        workspaceDir: '/workspace',
      },
    });

    await run();

    const result = JSON.parse(output.join(''));
    assert.equal(result.outcomes[0].component, 'agent');
    assert.equal(result.outcomes[0].status, 'unchanged');
  });

  it('should report installation failures and set a failing exit code', async () => {
    const { diagnostics, exitCodes, output, run } = createHarness({
      install: new Error('agent workspace conflict'),
    });

    await run();

    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(output, []);
    assert.deepEqual(diagnostics, ['install: agent workspace conflict\n']);
  });

  it('should attribute lifecycle reconciliation failures to their component', async () => {
    const { diagnostics, exitCodes, output, run } = createHarness({
      install: new AgentSystemLifecycleError(
        'github',
        'github-config-reconcile-failed',
        'GitHub config reconciliation failed.',
      ),
    });

    await run();

    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(output, []);
    assert.deepEqual(diagnostics, [
      'github: GitHub config reconciliation failed. code=github-config-reconcile-failed\n',
    ]);
  });

  it('should not install an invalid workspace manifest', async () => {
    const invalid: AgentManifestLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/current' },
      path: '/current/agent.yaml',
      diagnostics: [],
    };
    const { calls, exitCodes, run } = createHarness({ manifest: invalid });

    await run();

    assert.deepEqual(calls.install, []);
    assert.deepEqual(exitCodes, [1]);
  });
});
