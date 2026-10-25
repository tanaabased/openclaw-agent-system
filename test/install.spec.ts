import assert from 'node:assert/strict';

import { AutomationError, createAutomationGateway } from '../agent/automation-gateway.ts';
import { cliDiagnosticContext } from '../core/cli-diagnostic-context.ts';
import ansis from 'ansis';

import SetupLifecycleService from '../agent/setup-lifecycle.ts';
import { normalizeAgentSetup } from '../manifest/setup-schema.ts';
import installAgentSystem from '../cli/install.ts';
import AgentInstallService, {
  AgentInstallError,
  type AgentInstallResult,
} from '../agent/install-service.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { createCliStyles, type CliStyles } from '../cli/output.ts';
import AgentSystemLifecycleRegistry, {
  AgentSystemLifecycleError,
} from '../core/lifecycle-registry.ts';
import { dispatchCredentialError } from '../credentials/session-dispatch.ts';
import { observeReadiness } from '../credentials/session-dispatch-readiness-evidence.ts';
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
    installService?: Pick<AgentInstallService, 'install'>;
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
        installService: options.installService ?? {
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
  it('should not invent gateway evidence for unrelated automation failures', async () => {
    const harness = createHarness({
      json: true,
      install: new AgentSystemLifecycleError(
        'automations',
        'automation-ownership-conflict',
        'Automation reconciliation stopped.',
        { cause: new AutomationError('automation-ownership-conflict') },
      ),
    });
    await harness.run();
    assert.equal(
      JSON.parse(harness.output.join('')).blocked.automationGatewayDiagnostic,
      undefined,
    );
    assert.doesNotMatch(harness.diagnostics.join(''), /gateway diagnostic/u);
    assert.deepEqual(harness.exitCodes, [1]);
  });

  it('should report absent automation diagnostics as unknown without inventing dispatch evidence', async () => {
    const harness = createHarness({
      json: true,
      install: new AgentSystemLifecycleError(
        'automations',
        'automation-gateway-failed',
        'Automation reconciliation stopped.',
        { cause: new AutomationError('automation-gateway-failed') },
      ),
    });
    await harness.run();
    assert.deepEqual(JSON.parse(harness.output.join('')).blocked.automationGatewayDiagnostic, {
      method: null,
      category: 'unknown',
      gatewayCode: null,
      closeCode: null,
      requestDispatched: null,
    });
    assert.deepEqual(harness.exitCodes, [1]);
  });

  for (const [category, fields, code, expected] of [
    [
      'timeout',
      {
        name: 'GatewayTransportError',
        kind: 'timeout',
        requestDispatched: true,
        connectionDetails: {},
      },
      'automation-gateway-failed',
      { category: 'timeout', gatewayCode: null, closeCode: null, requestDispatched: true },
    ],
    [
      'closed',
      {
        name: 'GatewayTransportError',
        kind: 'closed',
        code: 1006,
        requestDispatched: false,
        connectionDetails: {},
      },
      'automation-gateway-unavailable',
      { category: 'closed', gatewayCode: null, closeCode: 1006, requestDispatched: false },
    ],
    [
      'rejected',
      { name: 'GatewayClientRequestError', gatewayCode: 'FORBIDDEN', retryable: false },
      'automation-gateway-rejected',
      { category: 'rejected', gatewayCode: 'FORBIDDEN', closeCode: null, requestDispatched: null },
    ],
    [
      'unknown',
      {},
      'automation-gateway-failed',
      { category: 'unknown', gatewayCode: null, closeCode: null, requestDispatched: null },
    ],
  ] as const) {
    it(`should preserve ${category} automation evidence through lifecycle wrapping and both install projections`, async () => {
      for (const json of [true, false]) {
        let calls = 0;
        const request = createAutomationGateway(async () => {
          calls += 1;
          throw Object.assign(new Error('private-token ws://private-host private-key'), fields, {
            connectionDetails: { token: 'private-token', url: 'ws://private-host' },
          });
        });
        const earlier = [
          {
            component: 'session-dispatch',
            code: 'session-dispatch-enrolled',
            status: 'created' as const,
            message: 'Enrollment completed.',
          },
          {
            component: 'github-intake',
            code: 'intake-activated',
            status: 'created' as const,
            message: 'Intake activated.',
          },
        ];
        const partial = {
          component: 'automations',
          stepId: 'first',
          code: 'automation-created',
          status: 'created' as const,
          message: 'Automation first',
        };
        const warning = {
          component: 'automations',
          code: 'fixture-warning',
          message: 'fixture warning',
        };
        const registry = new AgentSystemLifecycleRegistry([
          ...earlier.map((outcome) => ({
            id: outcome.component,
            isConfigured: () => true,
            reconcile: async () => ({ outcomes: [outcome] }),
          })),
          {
            id: 'automations',
            isConfigured: () => true,
            async reconcile() {
              try {
                await request('cron.add', { token: 'private-token' });
              } catch (error) {
                assert.ok(error instanceof AutomationError);
                Object.assign(error.diagnostic!, {
                  token: 'private-token',
                  connectionDetails: 'private-host',
                  toJSON: () => ({ token: 'private-token' }),
                });
                throw new AgentSystemLifecycleError(
                  'automations',
                  error.code,
                  'Automation reconciliation stopped.',
                  { cause: error },
                  undefined,
                  'second',
                  {
                    outcomes: [partial],
                    warnings: [warning],
                    unattempted: [{ component: 'automations', stepId: 'third' }],
                  },
                );
              }
              throw new Error('fixture transport must fail');
            },
          },
          {
            id: 'memory',
            isConfigured: () => true,
            reconcile: async () => {
              throw new Error('must remain unattempted');
            },
          },
        ]);
        const harness = createHarness({
          json,
          installService: new AgentInstallService({ lifecycleRegistry: registry }),
        });
        await harness.run();
        assert.equal(calls, 1);
        assert.deepEqual(harness.exitCodes, [1]);
        assert.doesNotMatch(harness.events.join(''), /private-/u);
        const diagnostic = { method: 'cron.add', ...expected };
        const stderr = harness.diagnostics.join('');
        assert.match(stderr, /gateway diagnostic/u);
        assert.ok(stderr.replace(/\s/gu, '').includes(JSON.stringify(diagnostic)));
        assert.ok(
          harness.events.indexOf(harness.output[0]!) <
            harness.events.indexOf(harness.diagnostics[0]!),
        );
        if (json) {
          const result = JSON.parse(harness.output.join(''));
          assert.deepEqual(result.blocked.automationGatewayDiagnostic, diagnostic);
          assert.equal(result.blocked.code, code);
          assert.equal(result.blocked.component, 'automations');
          assert.equal(result.blocked.stepId, 'second');
          assert.deepEqual(result.outcomes, [...earlier, partial]);
          assert.deepEqual(result.warnings, [warning]);
          assert.deepEqual(result.unattempted, [
            { component: 'automations', stepId: 'third' },
            { component: 'memory' },
          ]);
          assert.equal(result.earlierChangesRemainApplied, true);
          assert.doesNotMatch(stderr, /messages/u);
          assert.ok(!stderr.includes('\u001b'));
        } else {
          assert.equal(stderr.match(/^messages$/gmu)?.length, 1);
          assert.match(stderr, /earlier completed changes remain applied/u);
          assert.match(harness.output.join(''), /session-dispatch|github-channel-intake/u);
        }
      }
    });
  }

  it('should carry safe enrollment evidence through registry, install service and both cli projections', async () => {
    const diagnostic = {
      category: 'timeout' as const,
      phase: 'connection' as const,
      reasonCode: 'gateway-readiness-deadline' as const,
      readinessEvidence: {
        state: 'observed' as const,
        elapsedMs: 30_000,
        maxWaitMs: 30_000,
        totalObservations: 60,
        droppedObservations: 59,
        observations: [
          observeReadiness('/startupz', 29_500, undefined, {
            code: 'ECONNREFUSED',
            token: 'private-token',
          }),
        ],
      },
    };
    const registry = new AgentSystemLifecycleRegistry(
      [
        {
          id: 'session-dispatch',
          isConfigured: () => true,
          async reconcile() {
            dispatchCredentialError(
              'session-dispatch-enrollment-unverified',
              'Enrollment could not be verified.',
              Object.assign({}, diagnostic, { token: 'private-token' }),
            );
          },
        },
        {
          id: 'models',
          isConfigured: () => true,
          async reconcile() {
            throw new Error('must remain unattempted');
          },
        },
      ],
      {
        inspect: async () => [],
        reconcile: async () => ({
          outcomes: [
            {
              component: 'setup',
              stepId: 'host-step',
              code: 'setup-applied',
              status: 'updated',
              message: 'Setup step host-step',
            },
          ],
          warnings: [],
        }),
      },
    );
    const manifest = {
      ...validResult,
      manifest: {
        ...validResult.manifest,
        setupHost: {
          steps: [
            {
              id: 'host-step',
              apply: { kind: 'exec' as const, executable: 'fixture', args: [], timeoutSeconds: 1 },
            },
          ],
        },
      },
    };
    const installService = new AgentInstallService({ lifecycleRegistry: registry });
    for (const json of [false, true]) {
      const harness = createHarness({ installService, manifest, json });
      await harness.run();
      assert.deepEqual(harness.exitCodes, [1]);
      const output = harness.output.join('');
      const diagnostics = harness.diagnostics.join('');
      assert.ok(!harness.events.join('').includes('private-token'));
      assert.match(diagnostics, /category=timeout/);
      assert.match(diagnostics, /phase=connection/);
      assert.match(diagnostics, /reason=gateway-readiness-deadline/);
      assert.match(diagnostics, /readiness evidence/);
      assert.match(diagnostics, /connection-refused/);
      assert.match(diagnostics, /29500/);
      if (json) {
        const result = JSON.parse(output);
        assert.equal(result.status, 'failed');
        assert.deepEqual(result.blocked.sessionDispatchDiagnostic, diagnostic);
        assert.equal(result.blocked.code, 'session-dispatch-enrollment-unverified');
        assert.equal(result.outcomes[0].component, 'setup');
        assert.equal(result.outcomes[0].status, 'updated');
        assert.deepEqual(result.unattempted, [{ component: 'models' }]);
        assert.equal(result.earlierChangesRemainApplied, true);
      } else {
        assert.equal(diagnostics.match(/^messages$/gmu)?.length, 1);
        assert.ok(
          harness.events.join('').indexOf('workspace') <
            harness.events.join('').indexOf('messages'),
        );
      }
    }
  });

  it('should share doctor row details on success and partial failure without changing json', async () => {
    const outcomes = [
      {
        component: 'automations',
        stepId: 'backup-drive-nightly',
        code: 'automation-synchronized',
        status: 'unchanged' as const,
        message: 'Automation backup-drive-nightly is synchronized (independent).',
      },
    ];
    for (const failed of [false, true]) {
      const install = failed
        ? new AgentSystemLifecycleError(
            'models',
            'fixture-blocked',
            'FixtureBlocked',
            undefined,
            undefined,
            undefined,
            { outcomes, warnings: [], unattempted: [{ component: 'models' }] },
          )
        : { agentId: 'tanaabot', workspaceDir: '/workspace', warnings: [], outcomes };
      for (const json of [false, true]) {
        const harness = createHarness({ install, json });
        await harness.run();
        const text = harness.output.join('');
        if (json) assert.deepEqual(JSON.parse(text).outcomes, outcomes);
        else {
          assert.match(text, /automation\s+unchanged\s+name: BACKUP DRIVE NIGHTLY/u);
          assert.ok(text.replace(/\s+/gu, ' ').includes('mode: independent'));
          assert.equal(text.includes('backup-drive-nightly'), false);
        }
        assert.deepEqual(harness.exitCodes, failed ? [1] : []);
      }
    }
  });

  it('should preview fixture-backed success and partial failure across widths and color modes', async () => {
    const literal = 'AgentX /Work/AgentX/File.JSON OP_TOKEN 2026-10-07T23:00:00Z';
    const outcomes = installOutcomes.map((item) => ({
      ...item,
      message: `${item.message} ${literal}`,
    }));
    const warnings = [
      {
        component: 'collaboration',
        code: 'collaboration-session-access',
        message: `info A ${literal}`,
      },
      { component: 'git', code: 'warning-a', message: `warning A ${literal}` },
      { component: 'path', code: 'warning-b', message: `warning B ${literal}` },
    ];
    for (const failed of [false, true]) {
      const install = failed
        ? new AgentSystemLifecycleError(
            'github',
            'external-error',
            `HTTP 403: InvalidToken ${literal}`,
            undefined,
            undefined,
            undefined,
            { outcomes, warnings, unattempted: [{ component: 'models', stepId: 'ProfileX' }] },
          )
        : { agentId: 'AgentX', workspaceDir: '/Work/AgentX', outcomes, warnings };
      for (const terminalColumns of [32, 120]) {
        const previews: string[] = [];
        for (const environment of [{ FORCE_COLOR: '3' }, { NO_COLOR: '', FORCE_COLOR: '3' }]) {
          const harness = createHarness({
            install,
            terminalColumns,
            styles: createCliStyles(environment),
          });
          await harness.run();
          const text = ansis.strip(harness.events.join(''));
          previews.push(text);
          assert.equal(text.match(/^messages$/gmu)?.length, 1);
          assert.ok(text.indexOf('workspace  ') < text.indexOf('messages'));
          const unwrapped = text.replace(/\s/gu, '');
          assert.ok(unwrapped.includes(literal.replace(/\s/gu, '')));
          assert.ok(unwrapped.indexOf('warningA') < unwrapped.indexOf('warningB'));
          assert.ok(unwrapped.indexOf('warningB') < unwrapped.indexOf('infoA'));
          if (failed)
            assert.ok(unwrapped.indexOf('HTTP403:InvalidToken') < unwrapped.indexOf('warningA'));
          assert.deepEqual(harness.exitCodes, failed ? [1] : []);
          assert.deepEqual(
            harness.calls.install.map(({ manifest }) => manifest),
            [validResult.manifest],
          );
          const rows = text.split('\n').filter((row) => /^(agent|path|git|github)\s/.test(row));
          assert.deepEqual(
            rows.map((row) => row.trim().split(/\s/).filter(Boolean).slice(0, 2)),
            outcomes.map(({ component, status }) => [component, status]),
          );
        }
        assert.equal(previews[0], previews[1]);
      }
      const json = createHarness({
        install,
        json: true,
        styles: createCliStyles({ FORCE_COLOR: '3' }),
      });
      await json.run();
      const result = JSON.parse(json.output.join(''));
      assert.deepEqual(result.outcomes, outcomes);
      assert.deepEqual(result.warnings, warnings);
      if (failed) assert.equal(result.blocked.message, `HTTP 403: InvalidToken ${literal}`);
      assert.ok(!json.events.join('').includes('\u001b'));
      assert.ok(!json.diagnostics.join('').includes('messages'));
      assert.deepEqual(json.exitCodes, failed ? [1] : []);
    }
  });

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
            harness.events.join('').indexOf('messages'),
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
      assert.equal(text.match(/messages/gu)?.length, 1);
      assert.ok(text.indexOf('workspace  /workspace') < text.indexOf('messages'));
      assert.ok(text.indexOf('messages') < text.indexOf('Manifest warning.'));
      assert.match(text, /Operation warning/u);
      if (failed) {
        assert.match(text, /Operation stopped/u);
        assert.deepEqual(harness.exitCodes, [1]);
      } else assert.deepEqual(harness.exitCodes, []);
    }
  });

  it('should correlate manifest and completed warnings even before a partial failure', async () => {
    const context = {
      condition: {
        key: 'review-capability',
        component: 'github-intake',
        fieldPath: '/github/notifications/review-request',
      },
      remediation: ['disable unavailable reviews'],
    };
    const warning = {
      [cliDiagnosticContext]: context,
      component: 'github-intake',
      code: 'github-notification-runtime-unsupported',
      message: 'Review requests unavailable.',
    };
    const warnings = [
      warning,
      { component: 'setup', stepId: 'first', code: 'same-code', message: 'Step warning.' },
      { component: 'setup', stepId: 'second', code: 'same-code', message: 'Step warning.' },
    ];
    for (const json of [false, true])
      for (const failed of [false, true]) {
        const installed = {
          agentId: 'tanaabot',
          workspaceDir: '/workspace',
          outcomes: [],
          warnings,
        };
        const harness = createHarness({
          json,
          manifest: {
            ...validResult,
            diagnostics: [
              { ...warning, severity: 'warning', fieldPath: context.condition.fieldPath },
            ],
          },
          install: failed
            ? new AgentSystemLifecycleError(
                'github',
                'fixture-blocked',
                'Blocked.',
                undefined,
                undefined,
                undefined,
                { ...installed, unattempted: [{ component: 'models' }] },
              )
            : installed,
        });
        await harness.run();
        const stderr = harness.diagnostics.join('');
        assert.equal(stderr.match(/code=github-notification-runtime-unsupported/gu)?.length, 1);
        assert.equal(stderr.match(/disable unavailable reviews/gu)?.length, 1);
        assert.equal(stderr.match(/Step warning/gu)?.length, 2);
        assert.match(stderr, /step=first/u);
        assert.match(stderr, /step=second/u);
        assert.deepEqual(harness.exitCodes, failed ? [1] : []);
        if (json)
          assert.equal(
            JSON.stringify(JSON.parse(harness.output.join('')).warnings),
            JSON.stringify(warnings),
          );
        if (failed && !json) assert.equal(stderr.match(/✖ error/gu)?.length, 1);
      }
  });

  it('should omit only matching setup skip dispositions and retain same-code warnings elsewhere', async () => {
    for (const json of [false, true]) {
      const warnings = [
        { component: 'setup', code: 'setup-host-skipped', message: 'Selected host skip.' },
        { component: 'other', code: 'setup-host-skipped', message: 'Different component.' },
        {
          component: 'setup',
          stepId: 'individual',
          code: 'setup-host-skipped',
          message: 'Different step.',
        },
        { component: 'setup', code: 'setup-agent-skipped', message: 'Unselected phase.' },
      ];
      const harness = createHarness({
        json,
        skipSetupHost: true,
        install: { agentId: 'tanaabot', workspaceDir: '/workspace', outcomes: [], warnings },
      });
      await harness.run();
      const stderr = harness.diagnostics.join('');
      assert.doesNotMatch(stderr, /Selected host skip/u);
      assert.match(stderr, /Different component/u);
      assert.match(stderr, /Different step/u);
      assert.match(stderr, /Unselected phase/u);
      if (json) assert.deepEqual(JSON.parse(harness.output.join('')).warnings, warnings);
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
    assert.doesNotMatch(output.join(''), /warning/u);
    assert.match(diagnostics.join(''), /⚠ warning\n {2}path: The existing/u);
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
          /messages\n\n⚠ warning\n {2}path: Manual follow-up\./u,
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
    assert.doesNotMatch(output.join(''), /messages/u);
    const normalized = text.replace(/\s+/g, ' ');
    assert.match(normalized, /ℹ info operator recognition is channel-wide openclaw/u);
    assert.match(normalized, /⚠ warning github: Running Gateway access for pirog is unverified\./u);
    assert.match(normalized, /Reload the Gateway, then verify a fresh/u);
    assert.ok(text.replace(/\s/gu, '').includes('github-operator-loaded-access-unverified'));
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

  it('should order errors before retained warnings after completed work', async () => {
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
    assert.match(text, /✖ error/u);
    assert.ok(text.indexOf('✖ error') < text.indexOf('Keep this warning'));
    assert.ok(text.indexOf('unattempted work') < text.indexOf('Keep this warning'));
    assert.equal(text.match(/✖ error/gu)?.length, 1);
    assert.equal(text.includes('ℹ info'), false);
    assert.ok(text.indexOf('unattempted work') < text.indexOf('earlier completed'));
    assert.match(text, /code=collaboration-failed/u);
    assert.deepEqual(exitCodes, [1]);
  });

  it('should preserve safe setup termination through plain and json failure presentation', async () => {
    const setup = normalizeAgentSetup({
      steps: [
        { id: 'done', apply: 'private command' },
        { id: 'broken', apply: 'private secret' },
        { id: 'later', apply: 'private later' },
      ],
    });
    assert.equal(setup.status, 'valid');
    let calls = 0;
    const service = new SetupLifecycleService({
      async run() {
        return {
          exitCode: calls++ === 0 ? 0 : 23,
          timedOut: false,
          truncated: false,
          stdout: 'private output',
          stderr: 'debug: private error',
          diagnostic: 'private diagnostic',
        };
      },
    });
    let failure: Error | undefined;
    try {
      await service.reconcile({
        runtime: 'openclaw',
        workspaceDir: '/workspace',
        manifest: {
          ...validResult.manifest,
          setup: setup.setup,
        },
      });
    } catch (error) {
      assert.ok(error instanceof AgentSystemLifecycleError);
      failure = error;
    }
    assert.ok(failure);
    for (const json of [false, true]) {
      const harness = createHarness({ json, install: failure });
      await harness.run();
      const stderr = harness.diagnostics.join('');
      assert.match(stderr, /broken.*setup-agent.*apply/u);
      assert.match(stderr.replace(/\s+/gu, ' '), /exit code 23/u);
      assert.doesNotMatch(harness.output.join('') + stderr, /private/u);
      assert.deepEqual(harness.exitCodes, [1]);
      if (json) {
        assert.equal(harness.output.length, 1);
        const result = JSON.parse(harness.output[0]!);
        assert.match(result.blocked.message, /broken.*setup-agent.*apply.*exit code 23/u);
        assert.equal(result.blocked.code, 'setup-apply-failed');
        assert.equal(result.outcomes[0].stepId, 'done');
        assert.equal(result.unattempted[0].stepId, 'later');
      } else assert.equal(stderr.match(/messages/gu)?.length, 1);
    }
  });

  it('should report installation failures and set a failing exit code', async () => {
    const { diagnostics, exitCodes, output, run } = createHarness({
      install: new Error('agent workspace conflict'),
    });

    await run();

    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(output, []);
    assert.match(diagnostics.join(''), /install: agent workspace conflict/u);
    assert.match(diagnostics.join(''), /unattempted work: lifecycle/u);
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
    assert.match(diagnostics.join(''), /unattempted work: lifecycle/u);
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
    assert.match(harness.diagnostics.join(''), /error/u);
    assert.match(harness.diagnostics.join(''), /warning/u);
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
