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
  let configurationStatus: 'ready' | 'missing' | 'drift';
  let configurationRepairs: number;

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
    configurationStatus = 'ready';
    configurationRepairs = 0;
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
          async inspect(agentId) {
            return { configDir: join(root, agentId, 'gh-config'), status: configurationStatus };
          },
          async reconcile(agentId) {
            configurationRepairs++;
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

  function run(apply: unknown, mode: 'check' | 'apply' = 'apply') {
    return new SetupCommandService(dependencies).run(command(apply), {
      agentId: 'emori',
      workspaceDir,
      mode,
    });
  }

  it('should prepare configured tool credentials and key resources before launching any setup command', async () => {
    const service = new SetupCommandService(dependencies);
    await service.prepare({ manifest: loaded.manifest, workspaceDir });
    assert.deepEqual(
      requests.map(({ executable }) => executable),
      ['git', 'gh', 'gh'],
    );
    assert.equal(sshDisposals, 1);
    assert.equal(configurationRepairs, 0);
    assert.deepEqual(childEnvironments, []);
    credentials = {};
    await assert.rejects(service.prepare({ manifest: loaded.manifest, workspaceDir }), {
      code: 'setup-prerequisite-blocked',
    });
    assert.deepEqual(childEnvironments, []);
  });

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
    assert.equal(
      (
        await run(
          '(cd repo && git var GIT_AUTHOR_IDENT) > git-result\ncd repo\ngh api repos/owner/repo > result',
        )
      ).exitCode,
      0,
    );
    assert.deepEqual(requests[0]?.argv, ['var', 'GIT_AUTHOR_IDENT']);
    assert.equal(requests[0]?.cwd, join(workspaceDir, 'repo'));
    assert.equal(requests[0]?.environment.GIT_AUTHOR_NAME, 'Emori');
    assert.equal(requests[0]?.environment.GIT_AUTHOR_EMAIL, 'emori@example.invalid');
    assert.equal(await readFile(join(workspaceDir, 'git-result'), 'utf8'), '[REDACTED]\n');
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
    await assert.rejects(run('gh release delete v1 --repo owner/repo --yes'), {
      code: 'setup-tool-unavailable',
    });
    assert.deepEqual(environmentCalls, []);
    assert.deepEqual(requests, []);
  });

  it('should fail when credentials are missing without using operator credentials', async () => {
    credentials = {};
    await assert.rejects(run('gh api user'), { code: 'setup-tool-unavailable' });
    assert.deepEqual(environmentCalls, ['emori']);
    assert.deepEqual(requests, []);
  });

  it('should inspect managed configuration during checks without repairing it', async () => {
    assert.equal((await run('gh api user', 'check')).exitCode, 0);
    assert.equal(configurationRepairs, 0);
    requests.length = 0;
    for (const status of ['missing', 'drift'] as const) {
      configurationStatus = status;
      await assert.rejects(run('gh api user || true', 'check'), { code: 'setup-tool-unavailable' });
      assert.deepEqual(requests, []);
      assert.equal(configurationRepairs, 0);
    }
  });

  it('should distinguish ordinary tool exit one from unavailable tool execution', async () => {
    loaded.manifest.github = { token: 'EMORI_TOKEN' };
    const original = dependencies.toolRegistry.invoke.bind(dependencies.toolRegistry);
    dependencies.toolRegistry = {
      async invoke(...args) {
        const result = await original(...args);
        assert.equal(result.kind, 'cli');
        if (result.kind === 'cli') result.commandResult.exitCode = 1;
        return result;
      },
    };
    assert.equal((await run('gh api repos/owner/missing', 'check')).exitCode, 1);
    assert.equal(configurationRepairs, 0);
  });

  it('should surface managed tool timeouts and signals even when a script catches failure', async () => {
    const original = dependencies.toolRegistry.invoke.bind(dependencies.toolRegistry);
    for (const timedOut of [true, false]) {
      dependencies.toolRegistry = {
        async invoke(...args) {
          const result = await original(...args);
          assert.equal(result.kind, 'cli');
          if (result.kind === 'cli') {
            result.commandResult.timedOut = timedOut;
            result.commandResult.exitCode = timedOut ? 1 : null;
          }
          return result;
        },
      };
      await assert.rejects(run('gh api user || true', 'check'), {
        code: 'setup-tool-unavailable',
      });
    }
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
