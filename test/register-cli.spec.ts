import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { Command } from 'commander';

import { createAutomationGateway } from '../agent/automation-gateway.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import type { AgentEnvironmentLoadResult } from '../environment/service.ts';
import type { GitHubNotificationWaitInput } from '../channels/github/intake/monitor/status-service.ts';
import { createCliStyles } from '../cli/output.ts';
import { backupPreviewPlan } from './backup-presentation-fixtures.ts';
import { pruneFixture } from './backup-prune-presentation-fixtures.ts';
import { restoreFixtureManifest } from './cli-backup-restore-fixtures.ts';
import { doctorFindings, installOutcomes } from './lifecycle-presentation-fixtures.ts';
import registerAgentSystemCli, { type RegisterAgentSystemCliOptions } from '../cli/register.ts';
import type { OpCacheGatewayRequest } from '../cli/credentials-cache.ts';
import type { AgentSystemToolScope } from '../api/types.ts';
import OpCache from '../environment/op-cache.ts';
import WorkspaceBackupService from '../agent/backup-service.ts';
import type { BackupPlan, WorkspaceBackupManifest } from '../agent/backup-types.ts';

const validResult: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot', name: 'Tanaabot' } },
  diagnostics: [],
  validationChecks: [],
};
const validEnvironmentResult: Extract<AgentEnvironmentLoadResult, { status: 'loaded' }> = {
  ...validResult,
  status: 'loaded',
  environment: {
    values: { AGENT_COLOR: 'green' },
    variables: [
      {
        name: 'AGENT_COLOR',
        overriddenSources: [],
        required: false,
        source: 'environment.set',
      },
    ],
  },
};

function createProgram(
  input?: Readable,
  dependencies: {
    automationRunner?: boolean;
    automations?: RegisterAgentSystemCliOptions['automations'];
    backupService?: WorkspaceBackupService;
    manifestResult?: AgentManifestLoadResult;
    environment?: Readonly<NodeJS.ProcessEnv>;
    commandAuthority?: RegisterAgentSystemCliOptions['commandAuthority'];
    setupPrompt?: RegisterAgentSystemCliOptions['setupPrompt'];
    notificationWaitError?: Error;
    cacheGatewayRequest?: OpCacheGatewayRequest;
    terminalColumns?: number;
    toolExitCode?: number;
    toolStderr?: string;
    doctorFindings?: typeof doctorFindings;
    installOutcomes?: typeof installOutcomes;
  } = {},
) {
  const events: Array<{ stream: string; text: string }> = [];
  const diagnostics: string[] = [];
  const exitCodes: number[] = [];
  const output: string[] = [];
  const calls = {
    agent: [] as string[],
    credentialInput: [] as string[],
    credentialSet: [] as Array<{ agentId: string; storeId?: string; token: string }>,
    credentialUnset: [] as Array<{ agentId: string; storeId?: string }>,
    credentialValidate: [] as Array<{
      agentId: string;
      fromEnvironment?: boolean;
      storeId?: string;
    }>,
    doctor: [] as Array<{ agentId: string; workspaceDir: string }>,
    environmentAgent: [] as string[],
    environmentWorkspace: [] as string[],
    install: [] as Array<{
      manifest: unknown;
      rebuildCodexPath?: boolean;
      workspaceDir: string;
    }>,
    notificationRefresh: [] as Array<{
      agentId?: string;
      bypassInterval?: boolean;
      executionSurface?: string;
      selector?: { itemType: string; number: number; repository: string };
      signalPresent: boolean;
      waitForLeaseMs?: number;
    }>,
    notificationStatus: [] as Array<{
      agentId: string;
      selector?: { itemType: string; number: number; repository: string };
    }>,
    notificationWait: [] as GitHubNotificationWaitInput[],
    oneShotCompletion: [] as number[],
    tool: [] as Array<{
      argv: string[];
      command: string;
      scope: AgentSystemToolScope;
      stdin?: string;
    }>,
    workspace: [] as string[],
  };
  const program = new Command();
  program.name('openclaw').exitOverride();
  registerAgentSystemCli(program, {
    ...(dependencies.automationRunner
      ? { automations: {} as never, boundCommands: {} as never }
      : {}),
    ...(dependencies.automations ? { automations: dependencies.automations } : {}),
    backupService: dependencies.backupService,
    environment: dependencies.environment ?? {},
    ...(dependencies.commandAuthority ? { commandAuthority: dependencies.commandAuthority } : {}),
    ...(dependencies.setupPrompt ? { setupPrompt: dependencies.setupPrompt } : {}),
    cacheGatewayRequest: dependencies.cacheGatewayRequest,
    completeOneShot: async (code) => {
      calls.oneShotCompletion.push(code);
    },
    cwd: () => '/current',
    credentialInput: {
      async read(source) {
        calls.credentialInput.push(source);
        return { status: 'read', source, token: 'private-token' };
      },
    },
    credentialManager: {
      async set(manifest, token, storeId) {
        calls.credentialSet.push({
          agentId: manifest.agent.id,
          token,
          ...(storeId ? { storeId } : {}),
        });
        return { status: 'stored', agentId: manifest.agent.id, storeId: storeId ?? 'file' };
      },
      async unset(agentId, storeId) {
        calls.credentialUnset.push({ agentId, ...(storeId ? { storeId } : {}) });
        return {
          status: 'removed',
          agentId,
          storeIds: [storeId ?? 'file'],
          unavailableStoreIds: [],
        };
      },
      async validate(manifest, options = {}) {
        calls.credentialValidate.push({
          agentId: manifest.agent.id,
          ...options,
        });
        return {
          status: 'valid',
          agentId: manifest.agent.id,
          environmentCount: 1,
          secretCount: 0,
          source: options.storeId ? `store:${options.storeId}` : 'process-environment',
        };
      },
    },
    doctorService: {
      async inspect(input) {
        assert.equal(input.runtime, 'openclaw');
        calls.doctor.push({
          agentId: input.manifest.agent.id,
          workspaceDir: input.workspaceDir,
        });
        return {
          agentId: input.manifest.agent.id,
          findings: dependencies.doctorFindings ?? [],
          status: 'healthy',
          workspaceDir: input.workspaceDir,
        };
      },
    },
    environmentService: {
      async loadForAgentId(agentId) {
        calls.environmentAgent.push(agentId);
        return validEnvironmentResult;
      },
      async loadForCommandDirectory(workspaceDir) {
        calls.environmentWorkspace.push(workspaceDir);
        return validEnvironmentResult;
      },
    },
    installService: {
      async install(input) {
        calls.install.push(input);
        return {
          outcomes: dependencies.installOutcomes ?? [],
          agentId: 'tanaabot',
          warnings: [],
          workspaceDir: '/workspace',
        };
      },
    },
    ...(input ? { input } : {}),
    manifestService: {
      async loadForAgentId(agentId) {
        calls.agent.push(agentId);
        return dependencies.manifestResult ?? validResult;
      },
      async loadForCommandDirectory(workspaceDir) {
        calls.workspace.push(workspaceDir);
        return dependencies.manifestResult ?? validResult;
      },
    },
    notificationMonitorService: {
      async runOnce(options = {}) {
        const refreshOptions = 'aborted' in options ? {} : options;
        const { signal, ...recorded } = refreshOptions;
        calls.notificationRefresh.push({
          ...recorded,
          signalPresent: signal instanceof AbortSignal,
        });
        return [
          {
            agentId: refreshOptions.agentId ?? 'tanaabot',
            approved: 1,
            baseline: 0,
            baselineAt: 1_000,
            baselineEstablished: true,
            code: 'github-notification-poll-complete',
            duplicates: 0,
            rejected: 0,
            retired: 0,
            status: 'completed' as const,
          },
        ];
      },
    },
    notificationStatusService: {
      async inspect(agentId, selector) {
        calls.notificationStatus.push({ agentId, ...(selector ? { selector } : {}) });
        return {
          agentId,
          baseline: { observedAt: 1_000, status: 'ready' as const },
          capacity: { active: 0, limit: 2, queued: 0 },
          code: 'github-notification-status-ready',
          items: [],
          schemaVersion: 2 as const,
          status: 'ready' as const,
        };
      },
      async wait(input) {
        calls.notificationWait.push(input);
        if (dependencies.notificationWaitError) throw dependencies.notificationWaitError;
        return {
          agentId: input.agentId,
          code: `github-notification-${input.target}`,
          observation: {
            agentId: input.agentId,
            baseline: { observedAt: 1_000, status: 'ready' as const },
            capacity: { active: 0, limit: 2, queued: 0 },
            code: 'github-notification-status-ready',
            items: [],
            schemaVersion: 2 as const,
            status: 'ready' as const,
          },
          schemaVersion: 2 as const,
          status: 'completed' as const,
          target: input.target,
        };
      },
    },
    setExitCode: (code) => exitCodes.push(code),
    output: {
      writeStderr: (message) => {
        diagnostics.push(message);
        events.push({ stream: 'stderr', text: message });
      },
      writeStdout: (message) => {
        output.push(message);
        events.push({ stream: 'stdout', text: message });
      },
    },
    toolRegistry: {
      hostFallback: () => undefined,
      async invoke(command, _runtime, argv, scope, stdin) {
        calls.tool.push({
          argv,
          command,
          scope,
          ...(stdin === undefined ? {} : { stdin }),
        });
        return {
          auditId: 'audit-id',
          kind: 'cli' as const,
          commandResult: {
            exitCode: dependencies.toolExitCode ?? 0,
            stderr: dependencies.toolStderr ?? '',
            stdout: 'tanaabot\n',
            timedOut: false,
            truncated: false,
          },
          operation: {
            action: 'github.cli.invoke',
            risk: 'unknown',
            summary: 'Run gh api',
          },
          output: { id: 222685891, login: 'tanaabot' },
        };
      },
    },
    toolRuntime: {} as never,
    styles: createCliStyles({ NO_COLOR: '1' }),
    terminalColumns: dependencies.terminalColumns,
  });
  return { calls, diagnostics, output, program, exitCodes, events };
}

describe('cli/command-family-fixtures', () => {
  const leaves = [
    ['validate'],
    ['env'],
    ['doctor'],
    ['install'],
    ['credentials', 'set', 'op', '--from-env'],
    ['credentials', 'validate', 'op'],
    ['credentials', 'unset', 'op'],
    ['credentials', 'cache', 'status'],
    ['credentials', 'cache', 'flush'],
    ['backup', 'create', '--dry-run'],
    ['backup', 'prune', '--keep', '1', '--dry-run'],
    ['backup', 'verify', '/fixture.tar.gz'],
    ['backup', 'restore', '/fixture.tar.gz', '--target', '/recovery'],
    ['automations', 'list'],
    ['automations', 'sync'],
    ['automations', 'run', 'review'],
    ['automations', 'runs', 'review'],
    ['notifications', 'refresh'],
    ['notifications', 'status'],
    ['notifications', 'wait', '--for', 'baseline-ready'],
    ['tool', 'gh', '--', 'api', 'user'],
  ];
  class BackupFixture extends WorkspaceBackupService {
    override async plan() {
      return backupPreviewPlan;
    }
    override async prune() {
      return pruneFixture;
    }
    override async verify() {
      return restoreFixtureManifest('captured');
    }
    override async restore() {
      return { target: '/recovery', manifest: restoreFixtureManifest('captured') };
    }
  }
  const automations = {
    list: async () => ({
      status: 'aligned',
      jobs: [{ id: 'review', findings: [{ code: 'automation-healthy' }] }],
    }),
    reconcile: async () => ({ outcomes: [], warnings: [] }),
    run: async () => ({
      status: 'queued',
      runId: 'occurrence',
      execution: 'unavailable',
      delivery: 'unavailable',
    }),
    runs: async () => ({
      status: 'ok',
      entries: [{ runId: 'occurrence', execution: 'ok', delivery: 'delivered' }],
    }),
  } as never;

  it('should cover every current public leaf without treating aliases or hidden callbacks as leaves', () => {
    const { program } = createProgram(undefined, { automations, automationRunner: true });
    const names = (command: Command, prefix = ''): string[] =>
      command.commands.flatMap((child) => {
        const name = `${prefix}${child.name()}`;
        if (child.name() === 'automation-execute') return [];
        return child.commands.length ? names(child, `${name} `) : [name];
      });
    assert.equal(leaves.length, 21);
    assert.deepEqual(
      new Set(names(program.commands[0]!)),
      new Set(
        leaves.map((argv) =>
          argv
            .slice(
              0,
              argv[0] === 'credentials' && argv[1] === 'cache'
                ? 3
                : ['backup', 'automations', 'notifications', 'credentials'].includes(argv[0]!)
                  ? 2
                  : 1,
            )
            .join(' '),
        ),
      ),
    );
  });

  const humanSignals = [
    'valid',
    'environment',
    'workspace',
    'workspace',
    'stored',
    'valid',
    'removed',
    'gateway',
    'flushed',
    'preview',
    'prune',
    'verified',
    'staged',
    'aligned',
    'synchronized',
    'queued',
    'ok',
    'completed',
    'ready',
    'checkpoint reached',
    'tanaabot',
  ];
  for (const [index, argv] of leaves.entries()) {
    it(`should preserve ordered human and machine output for ${argv.slice(0, 3).join(' ')}`, async () => {
      for (const debug of [false, true]) {
        for (const json of [false, true]) {
          const machine =
            json && (!['tool', 'credentials'].includes(argv[0]!) || argv[1] === 'cache');
          const f = createProgram(undefined, {
            automations,
            backupService: new BackupFixture(),
            cacheGatewayRequest: async (action) => ({
              ...new OpCache().status(),
              runtime: 'gateway',
              ...(action === 'flush'
                ? { invalidated: { entries: 0, clients: 0, pending: 0, values: 0 } }
                : {}),
            }),
            environment: debug ? { OPENCLAW_DEBUG: '1', OPENCLAW_LOG_LEVEL: 'debug' } : {},
            manifestResult: {
              ...validResult,
              diagnostics: [
                { severity: 'warning', code: 'fixture-warning', message: 'fixture warning' },
              ],
            },
          });
          await f.program.parseAsync([
            'node',
            'openclaw',
            'as',
            ...argv,
            ...(machine ? ['--json'] : []),
          ]);
          const stdout = f.output.join('');
          const stderr = f.diagnostics.join('');
          assert.ok(stdout.length > 0);
          if (!machine) assert.ok(stdout.includes(humanSignals[index]!), stdout);
          assert.doesNotMatch(stdout + stderr, /private-token|AGENT_COLOR.*green/u);
          assert.deepEqual(f.exitCodes, []);
          const firstDiagnostic = f.events.findIndex(({ stream }) => stream === 'stderr');
          if (firstDiagnostic !== -1) {
            assert.ok(f.events.slice(firstDiagnostic).every(({ stream }) => stream === 'stderr'));
            if (machine) {
              assert.doesNotMatch(stderr, /messages/u);
              assert.ok(!stderr.includes('\u001b'));
            } else assert.equal(stderr.match(/messages/gu)?.length, 1);
          }
          if (machine) {
            assert.ok(!stdout.includes('\u001b'));
            assert.ok(JSON.parse(stdout));
          }
        }
      }
    });
  }

  it('should preserve delegated child bytes and nonzero exit codes without adding a message section', async () => {
    const f = createProgram(undefined, { toolExitCode: 17, toolStderr: 'Child MixedCase error\n' });
    await f.program.parseAsync(['node', 'openclaw', 'as', 'tool', 'gh', '--', 'api', 'user']);
    assert.deepEqual(f.events, [
      { stream: 'stdout', text: 'tanaabot\n' },
      { stream: 'stderr', text: 'Child MixedCase error\n' },
    ]);
    assert.deepEqual(f.exitCodes, [17]);
  });

  it('should reject malformed hidden execution with plain stderr and unchanged completion status', async () => {
    const f = createProgram(undefined, { automationRunner: true });
    await f.program.parseAsync([
      'node',
      'openclaw',
      'as',
      'automation-execute',
      '--id',
      'review',
      '--hash',
      'bad',
    ]);
    assert.deepEqual(f.output, []);
    assert.match(f.diagnostics.join(''), /code=automation-execution-options-invalid/u);
    assert.doesNotMatch(f.diagnostics.join(''), /messages/u);
    assert.ok(!f.diagnostics.join('').includes('\u001b'));
    assert.deepEqual(f.calls.oneShotCompletion, [1]);
  });
});

describe('cli/automation-commands', () => {
  it('should expose scheduler-wide inventory blockers in text without duplicating job findings', async () => {
    const healthy = { stepId: 'review', status: 'healthy', code: 'automation-healthy' };
    const scheduler = {
      stepId: 'scheduler',
      status: 'blocked',
      code: 'automation-scheduler-disabled',
    };
    for (const json of [false, true]) {
      const result = createProgram(undefined, {
        automations: {
          list: async () => ({
            status: 'attention',
            jobs: [{ id: 'review', nativeId: 'native', findings: [healthy] }],
            findings: [healthy, scheduler],
          }),
        } as never,
      });
      await result.program.parseAsync([
        'node',
        'openclaw',
        'as',
        'automations',
        'list',
        ...(json ? ['--json'] : []),
      ]);
      const output = result.output.join('');
      assert.ok(output.includes(scheduler.code));
      if (json) assert.deepEqual(JSON.parse(output).findings, [healthy, scheduler]);
      else assert.equal(output.split(healthy.code).length - 1, 1);
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.exitCodes, [1]);
    }
  });

  it('should pass both aliases and history flags through the production registration and output boundary', async () => {
    const calls: unknown[] = [];
    const automations = {
      list: async (...args: unknown[]) => {
        calls.push(['list', ...args]);
        return { status: 'aligned', jobs: [] };
      },
      reconcile: async (...args: unknown[]) => {
        calls.push(['sync', ...args]);
        return { outcomes: [], warnings: [] };
      },
      run: async (...args: unknown[]) => {
        calls.push(['run', ...args]);
        return {
          status: 'queued',
          runId: 'occurrence',
          execution: 'unavailable',
          delivery: 'unavailable',
        };
      },
      runs: async (...args: unknown[]) => {
        calls.push(['runs', ...args]);
        return { status: 'ok', entries: [], hasMore: false };
      },
    } as never;
    for (const alias of ['agent-system', 'as']) {
      for (const action of ['list', 'sync', 'run', 'runs']) {
        const result = createProgram(undefined, { automations });
        const args = [
          'node',
          'openclaw',
          alias,
          'automations',
          action,
          '--agent',
          'tanaabot',
          '--json',
        ];
        if (action === 'run' || action === 'runs') args.push('review');
        if (action === 'runs') args.push('--limit', '7', '--offset', '2', '--run-id', 'occurrence');
        await result.program.parseAsync(args);
        assert.equal(
          JSON.parse(result.output.join('')).status,
          { list: 'aligned', sync: 'synchronized', run: 'queued', runs: 'ok' }[action],
        );
        assert.deepEqual(result.diagnostics, []);
        assert.deepEqual(result.exitCodes, []);
        assert.deepEqual(result.calls.agent, ['tanaabot']);
      }
    }
    assert.deepEqual((calls[3] as unknown[]).slice(2), [
      '/workspace',
      'review',
      { limit: 7, offset: 2, runId: 'occurrence' },
    ]);
  });
  it('should block every operator route for descendants before reading a manifest or calling native transport', async () => {
    for (const action of ['list', 'sync', 'run', 'runs']) {
      const result = createProgram(undefined, {
        automations: {} as never,
        environment: { AGENT_SYSTEM_EXEC_AUTHORITY: 'invalid' },
      });
      await result.program.parseAsync([
        'node',
        'openclaw',
        'as',
        'automations',
        action,
        ...(['run', 'runs'].includes(action) ? ['review'] : []),
        '--json',
      ]);
      assert.ok(result.diagnostics.join('').includes('operator commands are unavailable'));
      assert.deepEqual(result.calls.workspace, []);
      assert.deepEqual(result.output, []);
      assert.deepEqual(result.exitCodes, [1]);
    }
  });
  it('should report safe gateway diagnostics in json and text through lifecycle wrappers', async () => {
    const request = createAutomationGateway(async () => {
      throw Object.assign(new Error('secret token and payload'), {
        name: 'GatewayClientRequestError',
        gatewayCode: 'INVALID_REQUEST',
        retryable: false,
        details: { token: 'secret' },
      });
    });
    for (const json of [true, false]) {
      for (const wrapped of [true, false]) {
        const result = createProgram(undefined, {
          automations: {
            reconcile: async () => {
              try {
                return await request('sessions.create', { token: 'secret' });
              } catch (error) {
                if (!wrapped) throw error;
                throw new AgentSystemLifecycleError(
                  'automations',
                  'automation-gateway-unavailable',
                  'stopped',
                  { cause: error },
                );
              }
            },
          } as never,
        });
        await result.program.parseAsync([
          'node',
          'openclaw',
          'as',
          'automations',
          'sync',
          ...(json ? ['--json'] : []),
        ]);
        if (json) {
          const output = JSON.parse(result.output.join(''));
          assert.equal(output.status, 'failed');
          assert.equal(output.diagnostic.method, 'sessions.create');
          assert.equal(output.diagnostic.category, 'rejected');
          assert.equal(output.diagnostic.gatewayCode, 'INVALID_REQUEST');
        } else assert.deepEqual(result.output, []);
        assert.match(result.diagnostics.join(''), /sessions\.create/u);
        assert.match(result.diagnostics.join(''), /INVALID_REQUEST/u);
        assert.ok(![...result.output, ...result.diagnostics].join('').includes('secret'));
        assert.deepEqual(result.exitCodes, [1]);
      }
    }
  });

  it('should print queued text and expose bounded partial failures on stdout and stderr', async () => {
    const result = createProgram(undefined, {
      automations: {
        run: async () => ({
          status: 'queued',
          runId: 'occurrence',
          execution: 'unavailable',
          delivery: 'unavailable',
        }),
      } as never,
    });
    await result.program.parseAsync(['node', 'openclaw', 'as', 'automations', 'run', 'review']);
    assert.match(result.output.join(''), /queued.*run=occurrence/su);
    const failed = createProgram(undefined, {
      automations: {
        reconcile: async () => {
          throw new Error('secret transport text');
        },
      } as never,
    });
    await failed.program.parseAsync(['node', 'openclaw', 'as', 'automations', 'sync', '--json']);
    assert.equal(JSON.parse(failed.output.join('')).code, 'automation-operation-failed');
    assert.deepEqual(failed.exitCodes, [1]);
    assert.ok(![...failed.diagnostics, ...failed.output].join('').includes('secret'));
  });
});

describe('cli/register', () => {
  it('should lowercase owned help descriptions while preserving host headings and env identifiers', () => {
    const { program } = createProgram();
    const root = program.commands.find((command) => command.name() === 'agent-system')!;
    const install = root.commands.find((command) => command.name() === 'install')!;
    const doctor = root.commands.find((command) => command.name() === 'doctor')!;
    const credentials = root.commands.find((command) => command.name() === 'credentials')!;
    const set = credentials.commands.find((command) => command.name() === 'set')!;
    assert.match(install.helpInformation(), /^Usage:/u);
    assert.match(install.helpInformation(), /confirm setup without prompting/u);
    assert.match(doctor.helpInformation(), /inspect agent system agent/u);
    assert.match(
      set.helpInformation(),
      /read OP_SERVICE_ACCOUNT_TOKEN from the process environment/u,
    );
    for (const command of [root, install, doctor, credentials, set]) {
      assert.equal(command.description(), command.description().toLowerCase());
    }
  });

  it('should report loaded manifest warnings consistently without corrupting command output', async () => {
    const commands = [
      ['doctor', '--json'],
      ['credentials', 'set', 'op', '--from-env'],
      ['credentials', 'unset', 'op'],
      ['credentials', 'validate', 'op', '--from-env'],
      ['notifications', 'status', '--json'],
      ['notifications', 'refresh', '--json'],
      ['notifications', 'wait', '--for', 'baseline-ready', '--json'],
    ];
    for (const argv of commands) {
      for (const selection of [[], ['--agent', 'tanaabot']]) {
        const { calls, diagnostics, output, program } = createProgram(undefined, {
          manifestResult: {
            ...validResult,
            diagnostics: [
              { code: 'manifest-shadowed', message: 'Root manifest ignored.', severity: 'warning' },
            ],
          },
        });
        await program.parseAsync(['node', 'openclaw', 'agent-system', ...argv, ...selection]);
        assert.equal(diagnostics.length, 1);
        assert.match(diagnostics[0]!, /code=manifest-shadowed/u);
        assert.equal(output.join('').includes('manifest-shadowed'), false);
        if (argv.includes('--json')) assert.doesNotThrow(() => JSON.parse(output.join('')));
        assert.deepEqual(calls.agent, selection.length ? ['tanaabot'] : []);
        assert.deepEqual(calls.workspace, selection.length ? [] : ['/current']);
      }
    }
  });

  it('should default cache controls to human output through both aliases', async () => {
    for (const alias of ['agent-system', 'as']) {
      for (const action of ['status', 'flush']) {
        const { program, output, diagnostics } = createProgram(undefined, {
          cacheGatewayRequest: async () => ({
            ...new OpCache().status(),
            runtime: 'gateway',
            ...(action === 'flush'
              ? { invalidated: { entries: 0, clients: 0, pending: 0, values: 0 } }
              : {}),
          }),
        });
        await program.parseAsync(['node', 'openclaw', alias, 'credentials', 'cache', action]);
        assert.deepEqual(diagnostics, []);
        assert.equal(output.length, 1);
        assert.match(output[0]!, /gateway.*pid/);
        assert.match(
          output[0]!,
          action === 'flush' ? /flushed.*all agents/ : /entries.*0 retained/,
        );
        assert.throws(() => JSON.parse(output[0]!));
      }
    }
  });

  it('should send cache controls to the gateway through both cli aliases', async () => {
    const calls: unknown[] = [];
    const { program, output } = createProgram(undefined, {
      cacheGatewayRequest: async (action, agentId) => {
        calls.push([action, agentId]);
        return { runtime: 'gateway', invalidated: { entries: 1 } };
      },
    });
    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'credentials',
      'cache',
      'status',
      '--json',
    ]);
    await program.parseAsync([
      'node',
      'openclaw',
      'as',
      'credentials',
      'cache',
      'flush',
      '--agent',
      'data',
      '--json',
    ]);
    assert.deepEqual(calls, [
      ['status', undefined],
      ['flush', 'data'],
    ]);
    assert.equal(JSON.parse(output[0]!).runtime, 'gateway');
  });

  it('should register agent-system with the as alias and owned subcommands', () => {
    const command = createProgram().program.commands[0];

    assert.equal(command?.name(), 'agent-system');
    assert.deepEqual(command?.aliases(), ['as']);
    assert.deepEqual(
      command?.commands.map((subcommand) => subcommand.name()),
      ['backup', 'validate', 'env', 'doctor', 'notifications', 'tool', 'credentials', 'install'],
    );
    assert.deepEqual(
      command?.commands
        .find((subcommand) => subcommand.name() === 'notifications')
        ?.commands.map((subcommand) => subcommand.name()),
      ['refresh', 'status', 'wait'],
    );
  });

  it('should hide the scheduler callback from public help while retaining explicit invocation', async () => {
    for (const alias of ['agent-system', 'as']) {
      const root = createProgram(undefined, { automationRunner: true });
      root.program.commands[0]!.configureOutput({ writeOut: (value) => root.output.push(value) });
      await assert.rejects(root.program.parseAsync(['node', 'openclaw', alias, '--help']), {
        code: 'commander.helpDisplayed',
      });
      assert.match(root.output.join(''), /automations/u);
      assert.doesNotMatch(root.output.join(''), /automation-execute/u);

      const callback = createProgram(undefined, { automationRunner: true });
      callback.program.commands[0]!.commands.find(
        (command) => command.name() === 'automation-execute',
      )!.configureOutput({ writeOut: (value) => callback.output.push(value) });
      await assert.rejects(
        callback.program.parseAsync(['node', 'openclaw', alias, 'automation-execute', '--help']),
        { code: 'commander.helpDisplayed' },
      );
      assert.match(callback.output.join(''), /--hash/u);
    }
  });

  it('should hide launcher options from help and typo suggestions through both aliases', async () => {
    for (const alias of ['agent-system', 'as']) {
      const { program } = createProgram();
      const tool = program.commands[0]!.commands.find((command) => command.name() === 'tool')!;
      const visible: string[] = [];
      tool.configureOutput({
        writeOut: (value) => visible.push(value),
        writeErr: (value) => visible.push(value),
      });
      await assert.rejects(program.parseAsync(['node', 'openclaw', alias, 'tool', '--help']), {
        code: 'commander.helpDisplayed',
      });
      assert.match(visible.join(''), /--agent/);
      assert.doesNotMatch(visible.join(''), /shim|contextual/iu);
      visible.length = 0;
      await assert.rejects(
        program.parseAsync(['node', 'openclaw', alias, 'tool', 'git', '--shi']),
        { code: 'commander.unknownOption' },
      );
      assert.doesNotMatch(visible.join(''), /--shim/);
    }
  });

  it('should reject missing or unsupported shim modes without advertising the option', async () => {
    for (const mode of [undefined, 'operator', 'unknown', '']) {
      const { calls, program, diagnostics } = createProgram();
      await program.parseAsync([
        'node',
        'openclaw',
        'agent-system',
        'tool',
        'git',
        '--shim',
        ...(mode === undefined ? [] : [mode]),
        '--',
        '--version',
      ]);
      assert.deepEqual(calls.tool, []);
      assert.match(diagnostics.join(''), /invalid internal launcher invocation/iu);
      assert.doesNotMatch(diagnostics.join(''), /shim|contextual/iu);
    }
  });

  it('should delegate tool arguments from the current workspace', async () => {
    const { calls, output, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'tool',
      'gh',
      '--',
      'api',
      'user',
    ]);

    assert.deepEqual(calls.tool, [
      {
        argv: ['api', 'user'],
        command: 'gh',
        scope: { source: 'command', workspaceDir: '/current' },
      },
    ]);
    assert.equal(output.join(''), 'tanaabot\n');
  });

  it('should delegate redirected tool input from the current workspace', async () => {
    const { calls, program } = createProgram(Readable.from(['{"title":"test"}\n']));

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'tool',
      'gh',
      '--',
      'api',
      '/repos/owner/repo/issues',
      '--input',
      '-',
    ]);

    assert.equal(calls.tool[0]?.stdin, '{"title":"test"}\n');
  });

  it('should delegate a tool command for an explicit agent', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'as',
      'tool',
      'gh',
      '--agent',
      'data',
      '--',
      'api',
      'user',
    ]);

    assert.deepEqual(calls.tool, [
      {
        argv: ['api', 'user'],
        command: 'gh',
        scope: { agentId: 'data', source: 'command', workspaceDir: '/current' },
      },
    ]);
  });

  it('should route worktree operations through the registered tool command', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'tool',
      'worktree',
      '--agent',
      'data',
      '--',
      'prepare',
      'repo',
      '123-fix-agent-path-resolution',
      'origin/main',
      '--clone-url',
      'git@github.com:example/repo.git',
    ]);

    assert.deepEqual(calls.tool, [
      {
        argv: [
          'prepare',
          'repo',
          '123-fix-agent-path-resolution',
          'origin/main',
          '--clone-url',
          'git@github.com:example/repo.git',
        ],
        command: 'worktree',
        scope: { agentId: 'data', source: 'command', workspaceDir: '/current' },
      },
    ]);
  });

  it('should show command help when invoked without a subcommand', async () => {
    const { output, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system']);

    assert.equal(output.join('').includes('validate'), true);
    assert.equal(output.join('').includes('install'), true);
    assert.equal(output.join('').includes('env'), true);
    assert.equal(output.join('').includes('credentials'), true);
    assert.equal(output.join('').includes('doctor'), true);
    assert.equal(output.join('').includes('status'), true);
  });

  it('should reject removed collaboration-only flags', async () => {
    for (const operation of ['install', 'doctor']) {
      const test = createProgram();
      await assert.rejects(
        test.program.parseAsync(['node', 'openclaw', 'as', operation, '--collaboration', '--json']),
        /unknown option/u,
      );
      assert.deepEqual(test.calls.install, []);
      assert.deepEqual(test.calls.doctor, []);
    }
  });

  it('should delegate doctor inspection for an explicit agent', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'doctor',
      '--agent',
      'data',
      '--json',
    ]);

    assert.deepEqual(calls.agent, ['data']);
    assert.deepEqual(calls.doctor, [{ agentId: 'tanaabot', workspaceDir: '/workspace' }]);
  });

  it('should delegate status aliases to doctor inspection', async () => {
    for (const commandRoot of ['agent-system', 'as']) {
      const { calls, program } = createProgram();

      await program.parseAsync([
        'node',
        'openclaw',
        commandRoot,
        'status',
        '--agent',
        'data',
        '--json',
      ]);

      assert.deepEqual(calls.agent, ['data']);
      assert.deepEqual(calls.doctor, [{ agentId: 'tanaabot', workspaceDir: '/workspace' }]);
    }
  });

  it('should delegate environment inspection with explicit agent and json options', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'env',
      '--agent',
      'data',
      '--json',
    ]);

    assert.deepEqual(calls.environmentAgent, ['data']);
  });

  it('should delegate workspace validation from the current directory', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'validate']);

    assert.deepEqual(calls.workspace, ['/current']);
  });

  it('should manually refresh notifications for the current workspace agent', async () => {
    const { calls, output, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'notifications',
      'refresh',
      '--json',
    ]);

    assert.deepEqual(calls.workspace, ['/current']);
    assert.deepEqual(calls.notificationRefresh, [
      {
        agentId: 'tanaabot',
        bypassInterval: true,
        executionSurface: 'cli-one-shot',
        signalPresent: true,
        waitForLeaseMs: 120_000,
      },
    ]);
    assert.equal(JSON.parse(output.join('')).code, 'github-notification-poll-complete');
    assert.deepEqual(calls.oneShotCompletion, [0]);
  });

  it('should report baseline readiness in human notification refresh output', async () => {
    const { output, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'notifications', 'refresh']);

    assert.match(
      output.join(''),
      /baseline\s+established at 1970-01-01T00:00:01.000Z with 0 existing assignments/,
    );
  });

  it('should target one notification item during refresh', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'notifications',
      'refresh',
      '--repository',
      'tanaabased/example',
      '--kind',
      'issue',
      '--number',
      '12',
      '--timeout',
      '45',
      '--json',
    ]);

    assert.deepEqual(calls.notificationRefresh[0]?.selector, {
      itemType: 'issue',
      number: 12,
      repository: 'tanaabased/example',
    });
    assert.equal(calls.notificationRefresh[0]?.waitForLeaseMs, 45_000);
  });

  it('should inspect one notification item through the status command', async () => {
    const { calls, output, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'notifications',
      'status',
      '--agent',
      'data',
      '--repository',
      'tanaabased/example',
      '--kind',
      'issue',
      '--number',
      '12',
      '--json',
    ]);

    assert.deepEqual(calls.notificationStatus, [
      {
        agentId: 'tanaabot',
        selector: { itemType: 'issue', number: 12, repository: 'tanaabased/example' },
      },
    ]);
    assert.equal(JSON.parse(output.join('')).status, 'ready');
    assert.deepEqual(calls.oneShotCompletion, []);
  });

  it('should wait for prepared intake with explicit refresh and timeout options', async () => {
    const { calls, output, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'notifications',
      'wait',
      '--repository',
      'tanaabased/example',
      '--kind',
      'pull-request',
      '--number',
      '13',
      '--for',
      'prepared',
      '--refresh',
      '--timeout',
      '45',
      '--json',
    ]);

    assert.deepEqual(calls.notificationWait, [
      {
        agentId: 'tanaabot',
        executionSurface: 'cli-one-shot',
        refresh: true,
        selector: {
          itemType: 'pull-request',
          number: 13,
          repository: 'tanaabased/example',
        },
        target: 'prepared',
        timeoutMs: 45_000,
      },
    ]);
    assert.equal(JSON.parse(output.join('')).status, 'completed');
    assert.deepEqual(calls.oneShotCompletion, [0]);
  });

  it('should complete a failed notification wait without corrupting json stdout', async () => {
    const { calls, diagnostics, output, program } = createProgram(undefined, {
      notificationWaitError: new Error('state unavailable'),
    });

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'notifications',
      'wait',
      '--repository',
      'tanaabased/example',
      '--kind',
      'issue',
      '--number',
      '12',
      '--for',
      'prepared',
      '--json',
    ]);

    assert.equal(output.join(''), '');
    assert.match(diagnostics.join(''), /code=github-notification-wait-failed/u);
    assert.deepEqual(calls.oneShotCompletion, [1]);
  });

  it('should register structured json validation output', async () => {
    const { output, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'validate', '--json']);

    assert.equal(JSON.parse(output.join('')).status, 'valid');
  });

  it('should pass an explicit agent through the short alias', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'as', 'validate', '--agent', 'tanaabot']);

    assert.deepEqual(calls.agent, ['tanaabot']);
  });

  it('should expose value-less setup switches and reject attached boolean values', async () => {
    for (const alias of ['agent-system', 'as']) {
      for (const flag of [
        '--yes',
        '--non-interactive',
        '--skip-setup',
        '--skip-setup-host',
        '--skip-setup-agent',
        '--rebuild-codex-path',
      ]) {
        const { program, calls } = createProgram();
        await program.parseAsync(['node', 'openclaw', alias, 'install', flag]);
        assert.equal(calls.install.length, 1);
        for (const value of ['true', 'false']) {
          const rejected = createProgram();
          rejected.program.configureOutput({ writeErr() {} });
          await assert.rejects(
            rejected.program.parseAsync(['node', 'openclaw', alias, 'install', `${flag}=${value}`]),
          );
          assert.deepEqual(rejected.calls.install, []);
          assert.deepEqual(rejected.calls.workspace, []);
        }
      }
    }
  });

  it('should preserve operator workspace discovery through contextual shims without session authority', async () => {
    for (const command of ['git', 'gh']) {
      const test = createProgram(undefined, {
        commandAuthority: {
          async classify() {
            return { status: 'unbound' };
          },
          async resolve() {
            throw new Error('unexpected strict resolution');
          },
        },
      });
      await test.program.parseAsync([
        'node',
        'openclaw',
        'as',
        'tool',
        command,
        '--shim',
        'contextual',
        '--',
        '--version',
      ]);
      assert.deepEqual(test.calls.workspace, ['/current']);
      assert.deepEqual(test.calls.tool, [
        {
          command,
          argv: ['--version'],
          scope: { source: 'command', workspaceDir: '/current' },
        },
      ]);
      assert.deepEqual(test.diagnostics, []);
    }
  });

  it('should deny setup operator routes for native and codex descendants before manifest loading', async () => {
    for (const alias of ['agent-system', 'as']) {
      for (const args of [
        ['automation-execute', '--id', 'job', '--hash', 'a'.repeat(64)],
        ['install', '--yes'],
        ['install', '--non-interactive'],
        ['install', '--skip-setup'],
        ['install', '--skip-setup-host'],
        ['install', '--skip-setup-agent'],
        ['install', '--rebuild-codex-path'],
        ['doctor'],
        ['status', '--agent', 'tanaabot'],
        ['credentials', 'set', 'op', '--from-env'],
        ['credentials', 'validate', 'op'],
        ['credentials', 'unset', 'op'],
        ['credentials', 'cache', 'status'],
        ['credentials', 'cache', 'flush'],
      ]) {
        for (const environment of [
          {
            AGENT_SYSTEM_EXEC_AUTHORITY: 'authority',
            AGENT_SYSTEM_EXEC_CAPABILITY: 'capability',
            CI: '1',
          },
          {
            CODEX_THREAD_ID: 'thread',
            CODEX_HOME: '/agent/codex-home',
            OPENCLAW_STATE_DIR: '/state',
          },
        ]) {
          const test = createProgram(undefined, {
            automationRunner: true,
            environment,
            commandAuthority: {
              async classify() {
                throw new Error('unexpected contextual lookup');
              },
              async resolve() {
                return {
                  agentId: 'tanaabot',
                  workingDirectory: '/workspace',
                  admittedWorkingDirectories: ['/workspace'],
                };
              },
            },
          });
          await test.program.parseAsync(['node', 'openclaw', alias, ...args]);
          assert.deepEqual(test.calls.install, []);
          assert.deepEqual(test.calls.doctor, []);
          assert.deepEqual(test.calls.workspace, []);
          assert.deepEqual(test.calls.credentialInput, []);
          assert.deepEqual(test.calls.credentialSet, []);
          assert.deepEqual(test.calls.credentialValidate, []);
          assert.deepEqual(test.calls.credentialUnset, []);
          assert.match(test.diagnostics.join(''), /operator commands/u);
        }
      }
    }
    const invalid = createProgram(undefined, {
      environment: { AGENT_SYSTEM_EXEC_CAPABILITY: 'invalid' },
      commandAuthority: {
        async classify() {
          throw new Error('unexpected contextual lookup');
        },
        async resolve() {
          throw new Error('private authority failure');
        },
      },
    });
    await invalid.program.parseAsync(['node', 'openclaw', 'as', 'install', '--yes']);
    assert.deepEqual(invalid.calls.install, []);
    assert.doesNotMatch(invalid.diagnostics.join(''), /private authority failure/u);
  });

  it('should delegate installation for the current workspace manifest', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'install']);

    assert.deepEqual(calls.workspace, ['/current']);
    assert.deepEqual(calls.install, [
      { manifest: validResult.manifest, workspaceDir: '/workspace', runtime: 'openclaw' },
    ]);
  });

  it('should pass an explicit Codex PATH rebuild through install', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'install',
      '--rebuild-codex-path',
    ]);

    assert.equal(calls.install[0]?.rebuildCodexPath, true);
  });

  it('should pass terminal width to doctor and install human output', async () => {
    for (const command of ['doctor', 'install']) {
      const { output, program } = createProgram(undefined, {
        terminalColumns: 32,
        doctorFindings: doctorFindings.filter(({ status }) => status === 'healthy'),
        installOutcomes,
      });
      await program.parseAsync(['node', 'openclaw', 'agent-system', command]);
      const rows = output.join('').trim().split('\n');
      assert.match(rows[0]!, /^agent\s+(healthy|unchanged)$/);
      assert.ok(rows[1]!.startsWith('  '));
      assert.ok(rows.slice(0, -3).every((row) => row.length <= 32));
    }
  });

  it('should register structured json installation output', async () => {
    const { output, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'install', '--json']);

    assert.equal(JSON.parse(output.join('')).agentId, 'tanaabot');
  });

  it('should preserve non-applicable setup in human and json results', async () => {
    const skipped = {
      component: 'setup',
      stepId: 'codex-only',
      code: 'setup-not-applicable',
      status: 'skipped' as const,
      message: 'Setup step codex-only does not apply to openclaw.',
    };
    for (const command of ['doctor', 'install']) {
      for (const json of [false, true]) {
        const { output, diagnostics, program } = createProgram(undefined, {
          doctorFindings: [skipped],
          installOutcomes: [skipped],
          environment: { CODEX_HOME: '/codex', AGENT_SYSTEM_RUNTIME: 'codex' },
        });
        await program.parseAsync(['node', 'openclaw', 'as', command, ...(json ? ['--json'] : [])]);
        assert.deepEqual(diagnostics, []);
        if (json) {
          const result = JSON.parse(output.join(''));
          assert.deepEqual(command === 'doctor' ? result.findings : result.outcomes, [skipped]);
        } else {
          assert.match(output.join(''), /skipped/u);
          assert.match(output.join(''), /codex-only/u);
          assert.match(output.join(''), /does not apply/u);
        }
      }
    }
  });

  it('should delegate credential storage from the process environment', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'credentials',
      'set',
      'op',
      '--store',
      'file',
      '--from-env',
    ]);

    assert.deepEqual(calls.credentialInput, ['environment']);
    assert.deepEqual(calls.credentialSet, [
      { agentId: 'tanaabot', storeId: 'file', token: 'private-token' },
    ]);
  });

  it('should delegate stdin storage with automatic store selection', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'credentials',
      'set',
      'op',
      '--stdin',
    ]);

    assert.deepEqual(calls.credentialInput, ['stdin']);
    assert.deepEqual(calls.credentialSet, [{ agentId: 'tanaabot', token: 'private-token' }]);
  });

  it('should delegate interactive storage by default', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'credentials', 'set', 'op']);

    assert.deepEqual(calls.credentialInput, ['prompt']);
    assert.deepEqual(calls.credentialSet, [{ agentId: 'tanaabot', token: 'private-token' }]);
  });

  it('should delegate exact-store credential validation for an agent', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'credentials',
      'validate',
      'op',
      '--agent',
      'data',
      '--store',
      'file',
    ]);

    assert.deepEqual(calls.credentialValidate, [{ agentId: 'tanaabot', storeId: 'file' }]);
    assert.deepEqual(calls.agent, ['data']);
  });

  it('should delegate process-environment credential validation', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'credentials',
      'validate',
      'op',
      '--from-env',
    ]);

    assert.deepEqual(calls.credentialValidate, [{ agentId: 'tanaabot', fromEnvironment: true }]);
  });

  it('should delegate removal from an explicit credential store', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'as',
      'credentials',
      'unset',
      'op',
      '--store',
      'file',
    ]);

    assert.deepEqual(calls.credentialUnset, [{ agentId: 'tanaabot', storeId: 'file' }]);
  });

  it('should delegate removal from every registered credential store by default', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'credentials', 'unset', 'op']);

    assert.deepEqual(calls.credentialUnset, [{ agentId: 'tanaabot' }]);
  });
});

describe('backup cli registration', () => {
  const plan: BackupPlan = {
    agentId: 'tanaabot',
    workspaceDir: '/workspace',
    settings: {
      output: '/workspace/backups',
      gitIgnore: false,
      openclawState: 'off',
      include: [],
      exclude: [],
    },
    coverage: {
      stage: 'workspace-only',
      openclawState: 'off',
      atomic: false,
      omittedPaths: [],
      limitations: [],
    },
    diagnostics: [],
    protectedPaths: [],
    files: ['MEMORY.md'],
  };

  it('should route operator restore through the alias with structured layout output', async () => {
    const calls: Array<{ archive: string; target: string; agentId?: string }> = [];
    const manifest: WorkspaceBackupManifest = {
      format: 'agent-system-backup',
      version: 2,
      agentId: 'tanaabot',
      capturedAt: '2026-09-28T00:00:00.000Z',
      settings: plan.settings,
      coverage: {
        stage: 'workspace-only',
        openclawState: 'off',
        atomic: false,
        omittedPaths: [],
        limitations: [],
      },
      diagnostics: [],
      inventory: [],
    };
    class Service extends WorkspaceBackupService {
      override async restore(archive: string, target: string, agentId?: string) {
        calls.push({ archive, target, ...(agentId ? { agentId } : {}) });
        return { target, manifest };
      }
    }
    const result = createProgram(undefined, { backupService: new Service() });
    await result.program.parseAsync([
      'node',
      'openclaw',
      'as',
      'backup',
      'restore',
      '/private/archive.tar.gz',
      '--target',
      '/private/recovery',
      '--agent',
      'tanaabot',
      '--json',
    ]);
    assert.deepEqual(calls, [
      { archive: '/private/archive.tar.gz', target: '/private/recovery', agentId: 'tanaabot' },
    ]);
    assert.equal(JSON.parse(result.output.join('')).status, 'restored');
    assert.equal(JSON.parse(result.output.join('')).workspace, '/private/recovery/workspace');
  });

  it('should require a restore target in structured output', async () => {
    const result = createProgram();
    await result.program.parseAsync([
      'node',
      'openclaw',
      'as',
      'backup',
      'restore',
      '/private/archive.tar.gz',
      '--json',
    ]);
    assert.equal(JSON.parse(result.output.join('')).diagnostics[0].code, 'backup-target-required');
  });

  it('should parse repeated multi-value lists and explicit false without overriding omitted settings', async () => {
    let overrides: unknown;
    class Service extends WorkspaceBackupService {
      override async plan(input: Parameters<WorkspaceBackupService['plan']>[0]) {
        overrides = input.overrides;
        return plan;
      }
    }
    const result = createProgram(undefined, { backupService: new Service() });
    await result.program.parseAsync([
      'node',
      'openclaw',
      'as',
      'backup',
      'create',
      '--dry-run',
      '--json',
      '--git-ignore=false',
      '--openclaw-state',
      'required',
      '--include',
      'MEMORY.md',
      'memory/**',
      '--include',
      'GOALS.md',
      '--exclude=',
    ]);
    assert.deepEqual(overrides, {
      gitIgnore: false,
      openclawState: 'required',
      include: ['MEMORY.md', 'memory/**', 'GOALS.md'],
      exclude: [],
    });
    const output = JSON.parse(result.output.join(''));
    assert.equal(output.status, 'preview');
    assert.equal(output.coverage.stage, 'workspace-only');
  });

  it('should reuse aligned cli summaries and color-free rendering', async () => {
    class Service extends WorkspaceBackupService {
      override async plan() {
        return plan;
      }
    }
    const result = createProgram(undefined, { backupService: new Service() });
    await result.program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'backup',
      'create',
      '--dry-run',
      '--include=',
    ]);
    const output = result.output.join('');
    assert.ok(output.includes('backup'));
    assert.ok(output.includes('preview'));
    assert.ok(output.includes('agent database off (not included)'));
    assert.ok(!output.includes('\u001b'));
  });

  it('should reject selectors for bound callers and prevent creation in setup checks', async () => {
    let planned = false;
    class Service extends WorkspaceBackupService {
      override async plan() {
        planned = true;
        return plan;
      }
    }
    const authority = {
      async resolve() {
        return {
          agentId: 'tanaabot',
          workingDirectory: '/workspace',
          admittedWorkingDirectories: ['/workspace'],
          setupMode: 'check' as const,
        };
      },
      async classify() {
        return { status: 'unbound' as const };
      },
    };
    for (const [args, code] of [
      [['--agent', 'other'], 'backup-agent-selector-forbidden'],
      [[], 'backup-setup-check-read-only'],
    ] as const) {
      const result = createProgram(undefined, {
        backupService: new Service(),
        commandAuthority: authority,
      });
      await result.program.parseAsync([
        'node',
        'openclaw',
        'as',
        'backup',
        'create',
        '--json',
        ...args,
      ]);
      assert.equal(JSON.parse(result.output.join('')).diagnostics[0].code, code);
    }
    assert.equal(planned, false);
  });

  it('should return structured failures when authority or manifest resolution fails', async () => {
    const result = createProgram(undefined, {
      environment: { AGENT_SYSTEM_EXEC_AUTHORITY: 'denied' },
    });
    await result.program.parseAsync([
      'node',
      'openclaw',
      'as',
      'backup',
      'verify',
      '/other.tar.gz',
      '--json',
    ]);
    assert.equal(JSON.parse(result.output.join('')).status, 'failed');
    assert.equal(
      JSON.parse(result.output.join('')).diagnostics[0].code,
      'backup-authority-unresolved',
    );
  });
});
