import assert from 'node:assert/strict';

import installAgentSystem from '../cli/install.ts';
import type { AgentInstallResult } from '../agent/install-service.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { createCliStyles, type CliStyles } from '../cli/output.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import { installOutcomes } from './lifecycle-presentation-fixtures.ts';

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
    styles?: CliStyles;
    terminalColumns?: number;
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
        styles: options.styles ?? createCliStyles({ NO_COLOR: '1' }),
        terminalColumns: options.terminalColumns,
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
    const rows = output.join('').trimEnd().split('\n');
    assert.deepEqual(
      rows.slice(0, 7).map((row) => row.split(/\s+/).slice(0, 2)),
      [
        ['agent', 'created'],
        ['agent', 'updated'],
        ['path', 'created'],
        ['path', 'updated'],
        ['path', 'created'],
        ['path', 'updated'],
        ['github', 'created'],
      ],
    );
    assert.deepEqual(rows.slice(-2), ['', 'workspace  /workspace']);
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

    const rows = output.join('').trimEnd().split('\n');
    assert.deepEqual(
      rows.slice(0, 3).map((row) => row.split(/\s+/).slice(0, 2)),
      [
        ['agent', 'unchanged'],
        ['path', 'unchanged'],
        ['github', 'unchanged'],
      ],
    );
    assert.deepEqual(rows.slice(-2), ['', 'workspace  /workspace']);
  });

  it('should retain operation order and warning routing in human and json output', async () => {
    const installed: AgentInstallResult = {
      agentId: 'tanaabot',
      outcomes: structuredClone(installOutcomes),
      warnings: [{ code: 'manual-follow-up', component: 'path', message: 'Manual follow-up.' }],
      workspaceDir: '/workspace',
    };
    const original = structuredClone(installed);
    Object.freeze(installed.outcomes);
    for (const json of [false, true]) {
      const harness = createHarness({
        install: installed,
        json,
        styles: createCliStyles(json ? { FORCE_COLOR: '3' } : { NO_COLOR: '1' }),
        terminalColumns: 40,
      });
      await harness.run();
      assert.deepEqual(harness.calls.install, [
        { manifest: validResult.manifest, workspaceDir: '/workspace' },
      ]);
      assert.deepEqual(harness.exitCodes, []);
      assert.deepEqual(harness.diagnostics, ['path: Manual follow-up. code=manual-follow-up\n']);
      const text = harness.output.join('');
      assert.equal(text.includes('manual-follow-up'), json);
      if (json) {
        assert.equal(harness.output.length, 1);
        assert.equal(text, `${JSON.stringify(original, undefined, 2)}\n`);
        assert.deepEqual(JSON.parse(text), original);
      } else {
        const rows = text.split('\n').filter((row) => /^(agent|path|git|github)\s/.test(row));
        assert.deepEqual(
          rows.map((row) => row.split(/\s+/).slice(0, 2)),
          installed.outcomes.map(({ component, status }) => [component, status]),
        );
        assert.ok(text.split('\n').some((row) => row.startsWith('  ')));
        for (const { message } of installed.outcomes) {
          assert.ok(text.replace(/\s+/g, ' ').includes(message));
        }
      }
      assert.deepEqual(installed, original);
    }
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
