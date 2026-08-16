import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { Command } from 'commander';

import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import type { AgentEnvironmentLoadResult } from '../lib/agent-environment-service.ts';
import type { GitHubNotificationWaitInput } from '../channels/github/lib/status-service.ts';
import { createCliStyles } from '../lib/cli-output.ts';
import registerAgentSystemCli from '../lib/register-cli.ts';
import type { AgentSystemToolScope } from '../lib/tool-types.ts';

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

function createProgram(input?: Readable) {
  const logs = { error: [] as string[], info: [] as string[], warn: [] as string[] };
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
    harnessDisposals: 0,
    environmentAgent: [] as string[],
    environmentWorkspace: [] as string[],
    install: [] as Array<{ manifest: unknown; workspaceDir: string }>,
    notificationRefresh: [] as Array<{
      agentId?: string;
      bypassInterval?: boolean;
      selector?: { itemType: string; number: number; repository: string };
      waitForLeaseMs?: number;
    }>,
    notificationStatus: [] as Array<{
      agentId: string;
      selector?: { itemType: string; number: number; repository: string };
    }>,
    notificationWait: [] as GitHubNotificationWaitInput[],
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
    async disposeAgentHarnesses() {
      calls.harnessDisposals += 1;
    },
    doctorService: {
      async inspect(input) {
        calls.doctor.push({
          agentId: input.manifest.agent.id,
          workspaceDir: input.workspaceDir,
        });
        return {
          agentId: input.manifest.agent.id,
          findings: [],
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
        return { outcomes: [], agentId: 'tanaabot', warnings: [], workspaceDir: '/workspace' };
      },
    },
    ...(input ? { input } : {}),
    logger: {
      error: (message) => logs.error.push(message),
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    manifestService: {
      async loadForAgentId(agentId) {
        calls.agent.push(agentId);
        return validResult;
      },
      async loadForCommandDirectory(workspaceDir) {
        calls.workspace.push(workspaceDir);
        return validResult;
      },
    },
    notificationMonitorService: {
      async runOnce(options = {}) {
        const refreshOptions = 'aborted' in options ? {} : options;
        calls.notificationRefresh.push(refreshOptions);
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
          code: 'github-notification-status-ready',
          items: [],
          schemaVersion: 2 as const,
          status: 'ready' as const,
        };
      },
      async wait(input) {
        calls.notificationWait.push(input);
        return {
          agentId: input.agentId,
          code: `github-notification-${input.target}`,
          observation: {
            agentId: input.agentId,
            baseline: { observedAt: 1_000, status: 'ready' as const },
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
    output: { writeStdout: (message) => output.push(message) },
    toolRegistry: {
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
            exitCode: 0,
            stderr: '',
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
  });
  return { calls, logs, output, program };
}

describe('lib/register-cli', () => {
  it('should register agent-system with the as alias and owned subcommands', () => {
    const command = createProgram().program.commands[0];

    assert.equal(command?.name(), 'agent-system');
    assert.deepEqual(command?.aliases(), ['as']);
    assert.deepEqual(
      command?.commands.map((subcommand) => subcommand.name()),
      ['validate', 'env', 'doctor', 'notifications', 'tool', 'credentials', 'install'],
    );
    assert.deepEqual(
      command?.commands
        .find((subcommand) => subcommand.name() === 'notifications')
        ?.commands.map((subcommand) => subcommand.name()),
      ['refresh', 'status', 'wait'],
    );
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
        waitForLeaseMs: 120_000,
      },
    ]);
    assert.equal(calls.harnessDisposals, 1);
    assert.equal(JSON.parse(output.join('')).code, 'github-notification-poll-complete');
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
      '--json',
    ]);

    assert.deepEqual(calls.notificationRefresh[0]?.selector, {
      itemType: 'issue',
      number: 12,
      repository: 'tanaabased/example',
    });
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

  it('should delegate installation for the current workspace manifest', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'install']);

    assert.deepEqual(calls.workspace, ['/current']);
    assert.deepEqual(calls.install, [
      { manifest: validResult.manifest, workspaceDir: '/workspace' },
    ]);
  });

  it('should register structured json installation output', async () => {
    const { output, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'install', '--json']);

    assert.equal(JSON.parse(output.join('')).agentId, 'tanaabot');
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
