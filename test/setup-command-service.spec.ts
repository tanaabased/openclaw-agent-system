import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AgentCommandAuthority from '../agent/command-authority.ts';
import SetupCommandService, {
  type SetupCommandServiceDependencies,
} from '../agent/setup-command-service.ts';
import AgentSystemToolRegistry from '../api/registry.ts';
import AgentSystemToolRuntime from '../api/runtime.ts';
import type { AgentSystemCliRunRequest } from '../api/types.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { normalizeAgentSetup, type AgentSetupCommand } from '../manifest/setup-schema.ts';
import { createGitHubTool } from '../tools/github/tool.ts';
import { createGitTool } from '../tools/git/tool.ts';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const childFixture = join(projectDir, 'test', 'setup-command-child.ts');
const quote = (value: string) => `'${value.replace(/'/gu, "'\\''")}'`;
type HostRunner = SetupCommandServiceDependencies['runCommandWithTimeout'];
const success = {
  code: 0,
  killed: false,
  signal: null,
  stdout: '',
  stderr: '',
  termination: 'exit' as const,
};

describe('agent/setup-command-service', function () {
  this.timeout(30_000);
  let root: string;
  let workspaceDir: string;
  let otherWorkspace: string;
  let hostBin: string;
  let authorityRoot: string;
  let loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }>;
  let environmentCalls: string[];
  let requests: AgentSystemCliRunRequest[];
  let childEnvironments: NodeJS.ProcessEnv[];
  let credentials: Record<string, string>;
  let dependencies: SetupCommandServiceDependencies;
  let sshDisposals: number;

  beforeEach(async () => {
    root = await realpath(await mkdtemp('/tmp/setup-binding-'));
    workspaceDir = join(root, 'emori');
    otherWorkspace = join(root, 'other');
    hostBin = join(root, 'bin');
    authorityRoot = join(root, 'authority');
    await Promise.all([workspaceDir, otherWorkspace, hostBin].map((path) => mkdir(path)));
    await mkdir(join(workspaceDir, 'repo'));
    await writeFile(
      join(hostBin, 'openclaw'),
      `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(createRequire(import.meta.url).resolve('tsx'))} ${quote(childFixture)} ${quote(authorityRoot)} "$@"\n`,
      { mode: 0o700 },
    );
    loaded = {
      status: 'loaded',
      scope: { agentId: 'emori', workspaceDir },
      path: join(workspaceDir, 'agent.yaml'),
      digest: 'test',
      diagnostics: [],
      validationChecks: [],
      manifest: {
        schemaVersion: 1,
        agent: { id: 'emori', name: 'Emori', email: 'emori@example.invalid' },
        git: { ssh: { privateKeys: [{ fromEnvironment: 'EMORI_SSH_KEY' }] } },
        github: { username: 'emori', token: 'EMORI_TOKEN', policy: { releases: 'deny' } },
      },
    };
    environmentCalls = [];
    requests = [];
    childEnvironments = [];
    credentials = {
      EMORI_TOKEN: 'agent-private-token',
      EMORI_SSH_KEY: 'agent-private-key-fixture',
    };
    sshDisposals = 0;
    const manifestService = {
      async loadForAgentId(id: string): Promise<AgentManifestLoadResult> {
        return id === 'emori' ? loaded : { status: 'unresolved', diagnostics: [] };
      },
      async loadForCommandDirectory(): Promise<never> {
        throw new Error('operator fallback');
      },
    };
    const toolRegistry = new AgentSystemToolRegistry([
      createGitTool({
        sshResourceService: {
          async acquire(request, scope) {
            assert.deepEqual(request.authentication?.privateKeys, [
              { fromEnvironment: 'EMORI_SSH_KEY' },
            ]);
            assert.equal(scope.resolveEnvironment('EMORI_SSH_KEY'), 'agent-private-key-fixture');
            assert.ok(scope.signal);
            return {
              environment: { GIT_SSH_COMMAND: 'fixture-agent-ssh' },
              sensitiveValues: ['agent-private-key-fixture'],
              async dispose() {
                sshDisposals++;
              },
            };
          },
        },
      }),
      createGitHubTool({
        configStore: {
          configDirectory: (agentId) => join(root, agentId, 'gh-config'),
          async reconcile(agentId) {
            return { configDir: join(root, agentId, 'gh-config'), status: 'unchanged' };
          },
        },
      }),
    ]);
    const toolRuntime = new AgentSystemToolRuntime({
      baseEnvironment: { PATH: hostBin, GH_TOKEN: 'operator-private-token' },
      manifestService,
      environmentService: {
        async loadForAgentId(id) {
          environmentCalls.push(id);
          return { ...loaded, environment: { values: credentials, variables: [] } };
        },
      },
      logger: { info() {}, error() {} },
      async runCli(request) {
        requests.push(request);
        return {
          exitCode: 0,
          stdout:
            request.executable === 'git'
              ? 'agent-private-key-fixture\n'
              : request.argv[1] === 'user'
                ? 'emori\n'
                : 'agent-private-token\n',
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const runCommandWithTimeout: HostRunner = async (argv, options) => {
      assert.ok(typeof options === 'object');
      childEnvironments.push(options.env ?? {});
      return new Promise((resolveResult, reject) => {
        const child = execFile(
          argv[0]!,
          argv.slice(1),
          {
            cwd: options.cwd,
            env: options.env,
            timeout: options.timeoutMs,
            encoding: 'utf8',
            maxBuffer: 65_536,
            ...(options.signal ? { signal: options.signal } : {}),
          },
          (error, stdout, stderr) => {
            if (error && typeof error.code !== 'number') {
              reject(error);
              return;
            }
            resolveResult({
              ...success,
              code: typeof error?.code === 'number' ? error.code : 0,
              stdout,
              stderr,
            });
          },
        );
        child.stdin?.end(options.input ?? '');
      });
    };
    dependencies = {
      authorityRoot,
      baseEnvironment: {
        PATH: [hostBin, '/bin', '/usr/bin'].join(delimiter),
        OPENCLAW_PROFILE: 'fixture',
        OPENCLAW_STATE_DIR: join(root, 'profile'),
        OPENCLAW_CONFIG_PATH: join(root, 'profile', 'openclaw.json'),
        GH_TOKEN: 'operator-private-token',
        EMORI_TOKEN: 'agent-private-token',
      },
      manifestService,
      packageDir: projectDir,
      runCommandWithTimeout,
      toolRegistry,
      toolRuntime,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function command(apply: unknown): AgentSetupCommand {
    const result = normalizeAgentSetup({ apply });
    assert.equal(result.status, 'valid');
    return result.setup.steps[0]!.apply;
  }

  function run(apply: unknown) {
    return new SetupCommandService(dependencies).run(command(apply), {
      agentId: 'emori',
      workspaceDir,
    });
  }

  it('should use agent credentials through real managed launcher subprocesses in every command form', async () => {
    for (const apply of [
      'gh api user --jq .login',
      ['gh', 'api', 'user', '--jq', '.login'],
      { command: 'gh', args: ['api', 'user', '--jq', '.login'] },
    ]) {
      assert.equal((await run(apply)).exitCode, 0);
    }
    assert.deepEqual(environmentCalls, ['emori', 'emori', 'emori']);
    assert.equal(requests.length, 6);
    for (const request of requests) {
      assert.equal(request.environment.GH_TOKEN, 'agent-private-token');
      assert.equal(request.environment.GH_CONFIG_DIR, join(root, 'emori', 'gh-config'));
      assert.ok(request.signal);
    }
    for (const environment of childEnvironments) {
      assert.equal(environment.GH_TOKEN, undefined);
      assert.equal(environment.EMORI_TOKEN, undefined);
      assert.ok(environment.AGENT_SYSTEM_EXEC_CAPABILITY);
      assert.equal(environment.OPENCLAW_PROFILE, 'fixture');
      assert.equal(environment.OPENCLAW_STATE_DIR, join(root, 'profile'));
      assert.equal(environment.OPENCLAW_CONFIG_PATH, join(root, 'profile', 'openclaw.json'));
    }
    assert.deepEqual(await readdir(authorityRoot), []);
  });

  it('should route git cloning through agent identity and invocation-scoped ssh resources', async () => {
    assert.equal(
      (await run('git clone git@github.com:owner/repo.git repo > git-result')).exitCode,
      0,
    );
    assert.deepEqual(requests[0]?.argv, ['clone', 'git@github.com:owner/repo.git', 'repo']);
    assert.equal(requests[0]?.environment.GIT_AUTHOR_NAME, 'Emori');
    assert.equal(requests[0]?.environment.GIT_AUTHOR_EMAIL, 'emori@example.invalid');
    assert.equal(requests[0]?.environment.GIT_SSH_COMMAND, 'fixture-agent-ssh');
    assert.equal(requests[0]?.environment.GH_TOKEN, undefined);
    assert.equal(childEnvironments[0]?.EMORI_SSH_KEY, undefined);
    assert.equal(childEnvironments[0]?.GIT_SSH_COMMAND, undefined);
    assert.equal(await readFile(join(workspaceDir, 'git-result'), 'utf8'), '[REDACTED]\n');
    assert.equal(sshDisposals, 1);
  });

  it('should retain identity after an admitted cwd change and redact provider output before returning it', async () => {
    assert.equal((await run('cd repo\ngh api repos/owner/repo > result')).exitCode, 0);
    assert.equal(requests.at(-1)?.cwd, join(workspaceDir, 'repo'));
    assert.equal(await readFile(join(workspaceDir, 'repo', 'result'), 'utf8'), '[REDACTED]\n');
  });

  it('should reject cross-agent cwd and explicit agent selection without resolving credentials', async () => {
    for (const script of [
      `cd ${quote(otherWorkspace)}\ngh api user`,
      'openclaw as tool gh --agent other -- api user',
    ]) {
      assert.equal((await run(script)).exitCode, 1);
    }
    assert.deepEqual(environmentCalls, []);
    assert.deepEqual(requests, []);
  });

  it('should apply tool policy before resolving credentials', async () => {
    assert.equal((await run('gh release delete v1 --repo owner/repo --yes')).exitCode, 1);
    assert.deepEqual(environmentCalls, []);
    assert.deepEqual(requests, []);
  });

  it('should fail when credentials are missing without using operator credentials', async () => {
    credentials = {};
    assert.equal((await run('gh api user')).exitCode, 1);
    assert.deepEqual(environmentCalls, ['emori']);
    assert.deepEqual(requests, []);
  });

  it('should reject setup and credential operator routes before invoking their services', async () => {
    const cases = [
      'agent-system install',
      'as doctor',
      'as status',
      'as credentials set op --from-env',
      'as credentials validate op',
      'as credentials unset op',
      'as credentials cache status',
      'as credentials cache flush',
    ];
    const script = cases
      .map((args, index) => `if openclaw ${args} 2> rejection-${index}; then exit 99; fi`)
      .join('\n');
    assert.equal((await run(script)).exitCode, 0);
    for (let index = 0; index < cases.length; index++) {
      assert.match(
        await readFile(join(workspaceDir, `rejection-${index}`), 'utf8'),
        /operator commands.*setup descendants/u,
      );
    }
    assert.deepEqual(environmentCalls, []);
  });

  it('should reject mismatched or unregistered target workspaces before launching setup', async () => {
    const service = new SetupCommandService(dependencies);
    for (const target of [
      { agentId: 'other', workspaceDir },
      { agentId: 'emori', workspaceDir: otherWorkspace },
    ]) {
      await assert.rejects(service.run(command('exit 0'), target), {
        code: 'setup-agent-not-resolved',
      });
    }
    assert.deepEqual(childEnvironments, []);
  });

  it('should revoke authority on success, timeout, cancellation, and launch failure', async () => {
    for (const outcome of ['success', 'timeout', 'cancel', 'throw'] as const) {
      let environment: NodeJS.ProcessEnv = {};
      dependencies.runCommandWithTimeout = async (_argv, options) => {
        assert.ok(typeof options === 'object');
        environment = options.env ?? {};
        if (outcome === 'throw') throw new Error('private launch error');
        return {
          ...success,
          code: outcome === 'success' ? 0 : null,
          termination: outcome === 'timeout' ? 'timeout' : outcome === 'cancel' ? 'signal' : 'exit',
        };
      };
      if (outcome === 'throw')
        await assert.rejects(run('exit 0'), { code: 'setup-execution-failed' });
      else await run('exit 0');
      const client = new AgentCommandAuthority({
        manifestService: dependencies.manifestService,
        rootDir: authorityRoot,
      });
      await assert.rejects(client.resolve(environment, workspaceDir));
      assert.deepEqual(await readdir(authorityRoot), []);
    }
  });
});
