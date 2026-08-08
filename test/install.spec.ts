import assert from 'node:assert/strict';

import installAgentSystem from '../cli/install.ts';
import type { AgentInstallResult } from '../lib/agent-install-service.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import { createCliStyles } from '../lib/cli-output.ts';

const validResult: AgentManifestLoadResult = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot', name: 'Tanaabot' } },
  diagnostics: [],
};

function createHarness(
  options: {
    install?: AgentInstallResult | Error;
    manifest?: AgentManifestLoadResult;
  } = {},
) {
  const logs = { error: [] as string[], info: [] as string[], warn: [] as string[] };
  const output: string[] = [];
  const calls = {
    install: [] as Array<{ manifest: unknown; workspaceDir: string }>,
    workspace: [] as string[],
  };
  const exitCodes: number[] = [];

  return {
    calls,
    exitCodes,
    logs,
    output,
    run: () =>
      installAgentSystem({
        installService: {
          async install(input) {
            calls.install.push(input);
            if (options.install instanceof Error) throw options.install;
            return (
              options.install ?? {
                actions: ['add-agent', 'set-identity'],
                agentId: 'tanaabot',
                warnings: [],
                workspaceDir: '/workspace',
              }
            );
          },
        },
        logger: {
          error: (message) => logs.error.push(message),
          info: (message) => logs.info.push(message),
          warn: (message) => logs.warn.push(message),
        },
        manifestService: {
          async loadForWorkspace(workspaceDir) {
            calls.workspace.push(workspaceDir);
            return options.manifest ?? validResult;
          },
        },
        output: { writeStdout: (message) => output.push(message) },
        setExitCode: (code) => exitCodes.push(code),
        styles: createCliStyles({ NO_COLOR: '1' }),
        workspaceDir: '/current',
      }),
  };
}

describe('cli/install', () => {
  it('should install a loaded workspace manifest and report completed actions', async () => {
    const { calls, output, run } = createHarness({
      install: {
        actions: [
          'add-agent',
          'set-identity',
          'create-workspace-bin',
          'set-exec-path',
          'create-codex-config',
          'update-gitignore',
          'create-github-config',
        ],
        agentId: 'tanaabot',
        codexStatus: 'managed',
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
      'created    OpenClaw agent tanaabot\nupdated    OpenClaw identity for tanaabot\ncreated    workspace bin directory\nupdated    OpenClaw exec path for tanaabot\ncreated    Codex workspace path configuration\nupdated    workspace .gitignore\ncreated    private GitHub CLI config\nworkspace  /workspace\n',
    ]);
  });

  it('should warn without styling a user-managed codex configuration', async () => {
    const { logs, run } = createHarness({
      install: {
        actions: [],
        agentId: 'tanaabot',
        codexStatus: 'manual',
        warnings: [
          {
            code: 'codex-config-user-managed',
            message: 'The existing .codex/config.toml is user-managed.',
          },
        ],
        workspaceDir: '/workspace',
      },
    });

    await run();

    assert.deepEqual(logs.warn, [
      'install: The existing .codex/config.toml is user-managed. code=codex-config-user-managed',
    ]);
  });

  it('should report an unchanged installed agent', async () => {
    const { output, run } = createHarness({
      install: { actions: [], agentId: 'tanaabot', warnings: [], workspaceDir: '/workspace' },
    });

    await run();

    assert.deepEqual(output, ['unchanged  OpenClaw agent tanaabot\nworkspace  /workspace\n']);
  });

  it('should report installation failures and set a failing exit code', async () => {
    const { exitCodes, logs, run } = createHarness({
      install: new Error('agent workspace conflict'),
    });

    await run();

    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(logs.error, ['install: agent workspace conflict']);
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
