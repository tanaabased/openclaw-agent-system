import assert from 'node:assert/strict';

import installAgentSystem from '../cli/install.ts';
import { AgentInstallError, type AgentInstallResult } from '../agent/install-service.ts';
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
    rebuildCodexPath?: boolean;
    skipSetupHost?: boolean;
    skipSetupAgent?: boolean;
    styles?: CliStyles;
    terminalColumns?: number;
  } = {},
) {
  const diagnostics: string[] = [];
  const output: string[] = [];
  const calls = {
    install: [] as Array<{
      manifest: unknown;
      rebuildCodexPath?: boolean;
      workspaceDir: string;
    }>,
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
        ...(options.rebuildCodexPath ? { rebuildCodexPath: true } : {}),
        ...(options.skipSetupHost ? { skipSetupHost: true } : {}),
        ...(options.skipSetupAgent ? { skipSetupAgent: true } : {}),
        styles: options.styles ?? createCliStyles({ NO_COLOR: '1' }),
        terminalColumns: options.terminalColumns,
        workspaceDir: '/current',
      }),
  };
}

describe('cli/install', () => {
  it('should forward an explicit Codex PATH rebuild', async () => {
    const { calls, run } = createHarness({ rebuildCodexPath: true });

    await run();

    assert.equal(calls.install[0]?.rebuildCodexPath, true);
  });

  it('should forward individual setup selections', async () => {
    const { calls, run } = createHarness({ skipSetupHost: true, skipSetupAgent: true });
    await run();
    assert.equal((calls.install[0] as { skipSetupHost?: boolean }).skipSetupHost, true);
    assert.equal((calls.install[0] as { skipSetupAgent?: boolean }).skipSetupAgent, true);
  });

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
      { manifest: validResult.manifest, workspaceDir: '/workspace', runtime: 'openclaw' },
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

  it('should render completed warnings beneath the results table', async () => {
    const { diagnostics, output, run } = createHarness({
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

    assert.deepEqual(diagnostics, []);
    assert.match(
      output.join(''),
      /workspace {2}\/workspace\n\nNotices\n\n⚠ Warning\n {2}The existing/u,
    );
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

  it('should retain operation order and keep warning codes in json diagnostics', async () => {
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
        { manifest: validResult.manifest, workspaceDir: '/workspace', runtime: 'openclaw' },
      ]);
      assert.deepEqual(harness.exitCodes, []);
      assert.deepEqual(
        harness.diagnostics,
        json ? ['path: Manual follow-up. code=manual-follow-up\n'] : [],
      );
      const text = harness.output.join('');
      assert.equal(text.includes('manual-follow-up'), json);
      if (json) {
        assert.equal(harness.output.length, 1);
        assert.equal(text, `${JSON.stringify(original, undefined, 2)}\n`);
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
        assert.match(text, /Notices\n\n⚠ Warning\n {2}Manual follow-up\./u);
      }
      assert.deepEqual(installed, original);
    }
  });

  it('should separate operator scope from an unverified Gateway warning', async () => {
    const { diagnostics, output, run } = createHarness({
      terminalColumns: 46,
      install: {
        outcomes: [
          {
            code: 'github-operator-grants-reconciled',
            component: 'github',
            message: 'Operator entry for pirog is saved.',
            status: 'unchanged',
          },
        ],
        agentId: 'tanaabot',
        warnings: [
          {
            code: 'github-operator-loaded-access-unverified',
            component: 'github',
            message:
              'Running Gateway access for pirog is unverified. Reload the Gateway, then verify a fresh assignment.',
          },
        ],
        workspaceDir: '/workspace',
      },
    });

    await run();

    const text = output.join('');
    assert.deepEqual(diagnostics, []);
    assert.ok(text.indexOf('workspace  /workspace') < text.indexOf('Notices'));
    const normalized = text.replace(/\s+/g, ' ');
    assert.match(normalized, /ℹ Notice Operator recognition is channel-wide OpenClaw/u);
    assert.match(normalized, /⚠ Warning Running Gateway access for pirog is unverified\./u);
    assert.match(normalized, /Reload the Gateway, then verify a fresh/u);
    assert.equal(text.includes('github-operator-loaded-access-unverified'), false);
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
    assert.match(diagnostics.join(''), /install: agent workspace conflict/u);
    assert.match(diagnostics.join(''), /Unattempted work: lifecycle/u);
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
    assert.match(
      diagnostics.join(''),
      /github: GitHub config reconciliation failed. code=github-config-reconcile-failed/u,
    );
    assert.match(diagnostics.join(''), /Unattempted work: lifecycle/u);
  });

  it('should report completed, blocked, and unattempted work in one json failure', async () => {
    const error = new AgentSystemLifecycleError(
      'google',
      'google-tool_unavailable',
      'Google requires gog on the host runtime PATH.',
      undefined,
      undefined,
      undefined,
      {
        outcomes: [
          {
            component: 'agent',
            code: 'agent-created',
            status: 'created',
            message: 'agent registered',
          },
        ],
        warnings: [],
        unattempted: [{ component: 'setup', stepId: 'agent-step' }],
      },
    );
    const { diagnostics, exitCodes, output, run } = createHarness({
      install: error,
      json: true,
      skipSetupHost: true,
    });
    await run();
    assert.deepEqual(exitCodes, [1]);
    const result = JSON.parse(output.join(''));
    assert.equal(result.status, 'failed');
    assert.deepEqual(
      result.outcomes.map(({ component }: { component: string }) => component),
      ['agent'],
    );
    assert.equal(result.blocked.component, 'google');
    assert.equal(result.blocked.code, 'google-tool_unavailable');
    assert.deepEqual(result.unattempted, [{ component: 'setup', stepId: 'agent-step' }]);
    assert.equal(result.earlierChangesRemainApplied, true);
    assert.match(result.hint, /Host setup was skipped/u);
    assert.match(diagnostics.join(''), /Earlier completed changes remain applied/u);
    assert.match(result.recovery, /blocking component may also have partial effects/u);
  });

  it('should keep preflight credential failures nonzero and structured', async () => {
    const { exitCodes, output, run } = createHarness({
      install: new AgentInstallError('Stored credential missing.', 'op-credential-not-stored'),
      json: true,
    });
    await run();
    assert.deepEqual(exitCodes, [1]);
    const result = JSON.parse(output.join(''));
    assert.equal(result.blocked.code, 'op-credential-not-stored');
    assert.deepEqual(result.outcomes, []);
    assert.deepEqual(result.unattempted, [{ component: 'lifecycle' }]);
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
