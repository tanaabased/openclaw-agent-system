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
  const events: string[] = [];
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
    events,
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
          writeStderr: (message) => {
            diagnostics.push(message);
            events.push(message);
          },
          writeStdout: (message) => {
            output.push(message);
            events.push(message);
          },
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
  it('should expose deferred automation sync in both output modes without failing install', async () => {
    const deferred = {
      component: 'automations',
      code: 'automation-sync-deferred',
      message:
        'Automation synchronization is deferred; scheduler state was not verified or changed.',
    };
    for (const json of [false, true]) {
      const harness = createHarness({
        json,
        install: {
          agentId: 'tanaabot',
          workspaceDir: '/workspace',
          outcomes: [{ ...deferred, status: 'skipped' }],
          warnings: [deferred],
        },
      });
      await harness.run();
      assert.deepEqual(harness.exitCodes, []);
      assert.match(harness.diagnostics.join(''), /deferred/u);
      if (json) {
        const result = JSON.parse(harness.output.join(''));
        assert.equal(result.outcomes[0].status, 'skipped');
        assert.equal(result.warnings[0].code, 'automation-sync-deferred');
        assert.equal(result.blocked, undefined);
      } else {
        assert.match(harness.output.join(''), /skipped/u);
        assert.ok(
          harness.events.join('').indexOf('workspace  /workspace') <
            harness.events.join('').indexOf('Messages'),
        );
      }
      assert.ok(!harness.output.join('').includes('automation-synchronized'));
    }
  });

  it('should combine manifest warnings with operation messages after the workspace footer', async () => {
    for (const failed of [false, true]) {
      const outcomes = [
        {
          code: 'agent-ready',
          component: 'agent',
          message: 'Agent ready.',
          status: 'unchanged' as const,
        },
      ];
      const warnings = [
        { code: 'operation-warning', component: 'git', message: 'Operation warning.' },
      ];
      const install = failed
        ? new AgentSystemLifecycleError(
            'github',
            'operation-stopped',
            'Operation stopped.',
            undefined,
            undefined,
            undefined,
            {
              outcomes,
              warnings,
              unattempted: [{ component: 'models' }],
            },
          )
        : { agentId: 'tanaabot', workspaceDir: '/workspace', outcomes, warnings };
      const harness = createHarness({
        install,
        manifest: {
          ...validResult,
          diagnostics: [
            { code: 'manifest-warning', message: 'Manifest warning.', severity: 'warning' },
          ],
        },
      });
      await harness.run();
      const text = harness.events.join('');
      assert.equal(text.match(/Messages/gu)?.length, 1);
      assert.ok(text.indexOf('workspace  /workspace') < text.indexOf('Messages'));
      assert.ok(text.indexOf('Messages') < text.indexOf('Manifest warning.'));
      assert.match(text, /Operation warning/u);
      if (failed) {
        assert.match(text, /Operation stopped/u);
        assert.deepEqual(harness.exitCodes, [1]);
      } else assert.deepEqual(harness.exitCodes, []);
    }
  });
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
    const rows = output.join('').trim().split('\n');
    assert.deepEqual(
      rows
        .filter(Boolean)
        .slice(0, 7)
        .map((row) => row.trim().split(/\s+/).slice(0, 2)),
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

  it('should keep completed warnings on stderr and primary results on stdout', async () => {
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

    assert.match(output.join(''), /workspace {2}\/workspace/u);
    assert.doesNotMatch(output.join(''), /Warning/u);
    assert.match(diagnostics.join(''), /⚠ Warning\n {2}The existing/u);
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

    const rows = output.join('').trim().split('\n');
    assert.deepEqual(
      rows
        .filter(Boolean)
        .slice(0, 3)
        .map((row) => row.trim().split(/\s+/).slice(0, 2)),
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
      if (json)
        assert.deepEqual(harness.diagnostics, ['path: Manual follow-up. code=manual-follow-up\n']);
      const text = harness.output.join('');
      assert.equal(text.includes('manual-follow-up'), json);
      if (json) {
        assert.equal(harness.output.length, 1);
        assert.equal(text, `${JSON.stringify(original, undefined, 2)}\n`);
      } else {
        const rows = text
          .split('\n')
          .map((row) => row.trim())
          .filter((row) => /^(agent|path|git|github)\s/.test(row));
        assert.deepEqual(
          rows.map((row) => row.trim().split(/\s+/).slice(0, 2)),
          installed.outcomes.map(({ component, status }) => [component, status]),
        );
        assert.ok(text.split('\n').some((row) => row.startsWith('  ')));
        for (const { message } of installed.outcomes) {
          assert.ok(text.replace(/\s+/g, ' ').includes(message));
        }
        assert.match(
          harness.diagnostics.join(''),
          /Messages\n\n⚠ Warning\n {2}Manual follow-up\./u,
        );
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

    const text = diagnostics.join('');
    assert.doesNotMatch(output.join(''), /Messages/u);
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

  it('should retain warnings before a styled blocking error after completed work', async () => {
    const failure = new AgentSystemLifecycleError(
      'collaboration',
      'collaboration-failed',
      'Cannot reconcile team.',
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
        warnings: [{ component: 'path', code: 'manual-follow-up', message: 'Keep this warning.' }],
        unattempted: [{ component: 'models' }],
      },
    );
    const { output, diagnostics, events, exitCodes, run } = createHarness({ install: failure });
    await run();
    assert.match(output.join(''), /agent registered/u);
    assert.ok(
      events.join('').indexOf('agent registered') < events.join('').indexOf('Keep this warning'),
    );
    assert.match(diagnostics.join(''), /code=manual-follow-up/u);
    const text = diagnostics.join('');
    assert.match(text, /Keep this warning/u);
    assert.match(text, /✖ Error/u);
    assert.ok(text.indexOf('Keep this warning') < text.indexOf('✖ Error'));
    assert.ok(text.indexOf('✖ Error') < text.indexOf('Unattempted work'));
    assert.ok(text.indexOf('Unattempted work') < text.indexOf('Earlier completed'));
    assert.match(text, /code=collaboration-failed/u);
    assert.deepEqual(exitCodes, [1]);
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
      diagnostics.join('').replace(/\s+/gu, ' '),
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
        warnings: [{ component: 'path', code: 'retained-warning', message: 'Retain in JSON.' }],
        unattempted: [{ component: 'setup', stepId: 'agent-step' }],
      },
    );
    const { diagnostics, exitCodes, output, run } = createHarness({
      install: error,
      json: true,
      styles: createCliStyles({ FORCE_COLOR: '3' }),
      skipSetupHost: true,
    });
    await run();
    assert.deepEqual(exitCodes, [1]);
    const result = JSON.parse(output.join(''));
    assert.equal(result.status, 'failed');
    assert.equal(result.warnings[0].code, 'retained-warning');
    assert.equal([...output, ...diagnostics].join('').includes('\u001b'), false);
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

  it('should preserve warning severity alongside a manifest failure', async () => {
    const harness = createHarness({
      manifest: {
        status: 'invalid',
        scope: { workspaceDir: '/workspace' },
        path: '/workspace/agent.yaml',
        diagnostics: [
          { severity: 'warning', code: 'manifest-warning', message: 'Retain this warning.' },
        ],
      },
    });
    await harness.run();
    assert.match(harness.diagnostics.join(''), /Error/u);
    assert.match(harness.diagnostics.join(''), /Warning/u);
    assert.match(harness.diagnostics.join(''), /manifest-warning/u);
    assert.deepEqual(harness.output, []);
    assert.deepEqual(harness.calls.install, []);
    assert.deepEqual(harness.exitCodes, [1]);
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
