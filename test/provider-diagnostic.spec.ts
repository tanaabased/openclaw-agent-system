import OpCache from '../environment/op-cache.ts';
import AgentDoctorService from '../agent/doctor-service.ts';
import createAgentLifecycleContribution from '../agent/lifecycle.ts';
import AgentSystemLifecycleRegistry from '../core/lifecycle-registry.ts';
import doctorAgentSystem from '../cli/doctor.ts';
import GitHubAccountClient, { GitHubAccountClientError } from '../core/github-account-client.ts';
import GitHubAccountKeyError from '../tools/github/account-key-error.ts';
import assert from 'node:assert/strict';
import {
  AuthExpiredError,
  DesktopSessionExpiredError,
  RateLimitExceededError,
} from '@1password/sdk';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import OpEnvironmentService from '../environment/op-service.ts';
import AgentEnvironmentService from '../environment/service.ts';
import AgentSystemToolRuntime from '../api/runtime.ts';
import AgentSystemToolError from '../api/error.ts';
import AgentSystemToolRegistry from '../api/registry.ts';
import defineCliTool from '../api/define-cli-tool.ts';
import runAgentSystemTool from '../cli/tool.ts';
import envAgentSystem from '../cli/env.ts';
import { formatManifestDiagnostics, formatErrorDiagnostic } from '../core/logger.ts';
import githubDiagnostic from '../credentials/github-diagnostic.ts';
import opDiagnostic from '../environment/op-diagnostic.ts';
import { providerDiagnostic, formatProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import GitHubWorkEventApiClient, {
  GitHubWorkEventClientError,
} from '../channels/github/provider/work-event-api-client.ts';
import {
  createToolTestDefinition,
  loadedToolTestManifest,
  toolTestWorkspaceDir,
} from './tool-test-fixture.ts';

const hostile =
  'ops_PRIVATE_TOKEN op://vault/item/password Authorization: Bearer PRIVATE_VALUE raw-command --token=PRIVATE_RESPONSE\n';
const manifest = loadedToolTestManifest({
  schemaVersion: 1,
  agent: { id: 'data' },
  environment: { set: { KEY: { fromOp: 'op://vault/item/password' } } },
});

function fixture(error: Error, creation = false, missing = false) {
  let calls = 0;
  const logs: string[] = [];
  const provider = new OpEnvironmentService({
    integrationVersion: 'test',
    credentialService: {
      async resolveServiceAccountToken() {
        if (missing) return { status: 'missing' };
        return {
          status: 'resolved',
          source: { type: 'store', id: 'file' },
          token: 'ops_PRIVATE_TOKEN',
        };
      },
    },
    async createClient() {
      if (creation) {
        calls++;
        throw error;
      }
      return {
        async resolveSecret() {
          calls++;
          throw error;
        },
        async getVariables() {
          calls++;
          throw error;
        },
      };
    },
  });
  const logger = {
    info: (message: string) => {
      logs.push(message);
    },
    error: (message: string) => {
      logs.push(message);
    },
  };
  const manifestService = {
    loadForAgentId: async () => manifest,
    loadForCommandDirectory: async () => manifest,
    loadForWorkspace: async () => manifest,
  };
  const environment = new AgentEnvironmentService({
    hostEnvironment: {},
    logger,
    manifestService,
    opEnvironmentService: provider,
  });
  const runtime = new AgentSystemToolRuntime({
    baseEnvironment: {},
    logger,
    manifestService,
    environmentService: environment,
    runCli: async () => {
      throw new Error('must not execute');
    },
  });
  return { provider, environment, runtime, logs, manifestService, calls: () => calls };
}

function redacted(value: unknown) {
  const text = JSON.stringify(value);
  for (const term of [
    'ops_PRIVATE',
    'op://',
    'Authorization',
    'PRIVATE_VALUE',
    'raw-command',
    'PRIVATE_RESPONSE',
  ])
    assert.ok(!text.includes(term), term);
}

describe('safe provider diagnostics', () => {
  for (const [error, classification, missing] of [
    [new RateLimitExceededError(hostile), 'rate-limit', false],
    [new AuthExpiredError(hostile), 'authentication', false],
    [new DesktopSessionExpiredError(hostile), 'authentication', false],
    [new Error(hostile), 'unknown', false],
    [new Error(hostile), 'missing-credential', true],
  ] as const) {
    it(`should preserve ${classification} through environment, native and managed cli consumers (${error.constructor.name.toLowerCase()})`, async () => {
      for (const creation of [false, true]) {
        const f = fixture(error, creation, missing);
        const loaded = await f.environment.loadForAgentId('data');
        assert.equal(loaded.status, 'invalid');
        const evidence = loaded.diagnostics[0]?.providerDiagnostic;
        assert.equal(evidence?.provider, '1password');
        assert.equal(evidence?.classification, classification);
        assert.equal(evidence?.httpStatus, null);
        assert.equal(evidence?.resetAt, null);
        assert.equal(evidence?.quotaScope, null);
        if (!missing) assert.ok(evidence!.localBackoffMs! > 0);
        const formatted = formatManifestDiagnostics(loaded);
        assert.ok(formatted[0]!.message.includes(`classification="${classification}"`));
        redacted(loaded);
        redacted(formatted);

        const registry = new AgentSystemToolRegistry([defineCliTool(createToolTestDefinition())]);
        let factory!: Parameters<OpenClawPluginApi['registerTool']>[0];
        registry.registerTools(
          {
            registerTool: (value) => {
              factory = value;
            },
          },
          f.runtime,
        );
        assert.equal(typeof factory, 'function');
        const tool = (
          factory as (context: unknown) => { execute: (...args: unknown[]) => Promise<unknown> }
        )({ agentId: 'data', workspaceDir: toolTestWorkspaceDir });
        await assert.rejects(tool.execute('call', { argument: 'status' }), (error: unknown) => {
          assert.ok(error instanceof AgentSystemToolError);
          assert.equal(error.providerDiagnostic?.classification, classification);
          assert.match(error.message, /tool environment is unavailable/);
          assert.match(error.message, /httpStatus="unknown"/);
          redacted(error.message);
          return true;
        });
        const stdout: string[] = [];
        const stderr: string[] = [];
        let code = 0;
        await runAgentSystemTool({
          command: 'test-tool',
          argv: ['status'],
          workspaceDir: toolTestWorkspaceDir,
          agentId: 'data',
          toolRegistry: registry,
          toolRuntime: f.runtime,
          output: {
            writeStdout: (value) => {
              stdout.push(value);
            },
            writeStderr: (value) => {
              stderr.push(value);
            },
          },
          setExitCode: (value) => {
            code = value;
          },
        });
        assert.equal(code, 1);
        assert.deepEqual(stdout, []);
        assert.ok(stderr.join('').includes(`classification="${classification}"`));
        assert.ok(stderr.join('').includes('provider="1password"'));
        redacted(stderr);
        redacted(f.logs);
        assert.ok(f.logs.some((line) => line.includes(`classification="${classification}"`)));
        assert.equal(f.calls(), missing ? 0 : 1, 'backoff never multiplies provider calls');
      }
    });
  }

  it('should carry underlying provider failures through github connection and existing doctor findings', async () => {
    const f = fixture(new RateLimitExceededError(hostile));
    const account = new GitHubAccountClient({
      baseEnvironment: {},
      configStore: { configDirectory: () => '/unused' },
      environmentService: f.environment,
      runCli: async () => {
        throw new Error('must not execute');
      },
    });
    await assert.rejects(
      account.connect({
        manifest: { ...manifest.manifest, github: { username: 'data', token: 'KEY' } },
        workspaceDir: toolTestWorkspaceDir,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubAccountClientError);
        assert.equal(error.providerDiagnostic?.provider, '1password');
        assert.equal(error.providerDiagnostic?.classification, 'rate-limit');
        redacted(error.message);
        return true;
      },
    );
    const doctorManifest = {
      ...manifest,
      manifest: { ...manifest.manifest, agent: { id: 'data', name: { fromEnvironment: 'KEY' } } },
    };
    const doctorService = new AgentDoctorService({
      lifecycleRegistry: new AgentSystemLifecycleRegistry([
        createAgentLifecycleContribution({
          environmentService: f.environment,
          readConfig: () => ({}),
          runOpenClawCommand: async () => {
            throw new Error('doctor must not repair');
          },
        }),
      ]),
    });
    for (const json of [false, true]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let exitCode = 0;
      await doctorAgentSystem({
        agentId: 'data',
        doctorService,
        json,
        manifestService: {
          loadForAgentId: async () => doctorManifest,
          loadForCommandDirectory: async () => doctorManifest,
        },
        workspaceDir: toolTestWorkspaceDir,
        output: {
          writeStdout: (value) => {
            stdout.push(value);
          },
          writeStderr: (value) => {
            stderr.push(value);
          },
        },
        setExitCode: (code) => {
          exitCode = code;
        },
      });
      assert.equal(exitCode, 1);
      assert.deepEqual(stderr, []);
      redacted(stdout);
      if (json) {
        const result = JSON.parse(stdout.join(''));
        assert.equal(result.findings[0].providerDiagnostic.provider, '1password');
        assert.equal(result.findings[0].providerDiagnostic.classification, 'rate-limit');
        assert.equal(result.findings[0].providerDiagnostic.resetAt, null);
      } else {
        assert.match(stdout.join(''), /classification="rate-limit"/);
      }
    }
    assert.equal(f.calls(), 1);
  });

  it('should preserve known throttling when a concurrent opaque failure also enters backoff', () => {
    const cache = new OpCache(() => 1000);
    cache.failure(
      'synthetic-token',
      opDiagnostic(new RateLimitExceededError(hostile), 'secret-resolve'),
    );
    cache.failure('synthetic-token', opDiagnostic(new Error(hostile), 'environment-read'));
    assert.equal(cache.backoffDiagnostic('synthetic-token').classification, 'rate-limit');
    assert.equal(cache.backoffDiagnostic('synthetic-token').resetAt, null);
  });

  it('should retain a fractional clock backoff as bounded whole milliseconds', () => {
    let now = 1000.1;
    const cache = new OpCache(() => now);
    const evidence = cache.failure(
      'synthetic-token',
      opDiagnostic(new Error(hostile), 'secret-resolve'),
    );
    assert.equal(evidence.localBackoffMs, 30_000);
    now += 0.25;
    assert.equal(cache.backoffDiagnostic('synthetic-token').localBackoffMs, 30_000);
    now += 30_000;
    assert.equal(cache.backoffDiagnostic('synthetic-token').localBackoffMs, 0);
  });

  it('should preserve typed authentication and reject name or message-based classifications', () => {
    for (const ErrorType of [AuthExpiredError, DesktopSessionExpiredError]) {
      assert.equal(
        opDiagnostic(new ErrorType(hostile), 'client-create').classification,
        'authentication',
      );
    }
    for (const error of [
      new Error(hostile),
      Object.assign(new Error('HTTP 429'), {
        name: 'RateLimitExceededError',
        status: 429,
        resetAt: 123,
      }),
      { constructor: { name: 'AuthExpiredError' } },
    ]) {
      const result = opDiagnostic(error, 'secret-resolve');
      assert.equal(result.classification, 'unknown');
      assert.equal(result.httpStatus, null);
      redacted(result);
    }
  });

  it('should allowlist supplied github status and retry metadata without interpreting provider prose', async () => {
    for (const [status, classification] of [
      [401, 'authentication'],
      [403, 'permission'],
      [429, 'rate-limit'],
      [503, 'transport'],
      [404, 'unknown'],
    ] as const) {
      const api = new GitHubWorkEventApiClient({
        identity: { login: 'data', nodeId: 'U_data' },
        execute: async () => ({
          exitCode: 1,
          stdout: `HTTP/2 ${status}\nx-ratelimit-reset: 1800000000\nretry-after: 10\nX-Untrusted: ${hostile.trim()}\n\n${hostile}`,
          stderr: hostile,
          timedOut: false,
          truncated: false,
        }),
      });
      await assert.rejects(api.request(['user'], 'identity'), (error: unknown) => {
        assert.ok(error instanceof GitHubWorkEventClientError);
        assert.equal(
          error.providerDiagnostic?.classification,
          status === 403 ? 'rate-limit' : classification,
        );
        assert.equal(error.providerDiagnostic?.httpStatus, status);
        assert.equal(error.providerDiagnostic?.resetAt, 1_800_000_000_000);
        assert.equal(error.providerDiagnostic?.retryAfterMs, 10_000);
        redacted(error.message);
        redacted(error.providerDiagnostic);
        return true;
      });
      assert.equal(githubDiagnostic({ status }).classification, classification);
    }
    assert.equal(githubDiagnostic({ status: 403, remaining: 0 }).classification, 'rate-limit');
    assert.equal(githubDiagnostic({ timedOut: true }).classification, 'transport');
    assert.equal(githubDiagnostic({ status: 403, retryAfterMs: NaN }).classification, 'permission');
    const safe = providerDiagnostic('github', 'api-request', 'rate-limit', {
      explanation: hostile,
      httpStatus: Infinity,
      resetAt: NaN,
      providerCode: hostile as never,
      quotaScope: hostile as never,
    });
    redacted(formatProviderDiagnostic(safe));
    assert.equal(safe.httpStatus, null);
  });

  it('should not leak nested causes through the host error formatter', () => {
    const cause = new Error(hostile, { cause: { headers: hostile, body: hostile } });
    for (const error of [
      new GitHubAccountClientError('github-account-tool-unavailable', 'GitHub request failed.', {
        cause,
      }),
      new GitHubWorkEventClientError(
        'github-notification-request-failed',
        'GitHub request failed.',
        {},
        { cause },
      ),
      new GitHubAccountKeyError('github-account-key-request-failed', 'GitHub request failed.', {
        cause,
      }),
    ]) {
      assert.equal(error.cause, undefined);
      redacted(formatErrorDiagnostic('github', error));
    }
  });

  it('should withhold unknown github execution exceptions and classify a timed-out response', async () => {
    for (const timedOut of [false, true]) {
      const api = new GitHubWorkEventApiClient({
        identity: { login: 'data', nodeId: 'U_data' },
        execute: async () => {
          if (!timedOut) throw new Error(hostile);
          return {
            exitCode: null,
            stdout: hostile,
            stderr: hostile,
            timedOut: true,
            truncated: false,
          };
        },
      });
      await assert.rejects(api.request(['user'], 'identity'), (error: unknown) => {
        assert.ok(error instanceof GitHubWorkEventClientError);
        assert.equal(error.providerDiagnostic?.classification, timedOut ? 'transport' : 'unknown');
        redacted(error.message);
        return true;
      });
    }
  });

  it('should render safe environment diagnostics without contaminating json stdout', async () => {
    const f = fixture(new RateLimitExceededError(hostile));
    const stdout: string[] = [];
    const stderr: string[] = [];
    await envAgentSystem({
      agentId: 'data',
      environmentService: f.environment,
      json: true,
      workspaceDir: toolTestWorkspaceDir,
      output: {
        writeStdout: (value) => {
          stdout.push(value);
        },
        writeStderr: (value) => {
          stderr.push(value);
        },
      },
      setExitCode() {},
    });
    assert.deepEqual(stdout, []);
    assert.match(stderr.join(''), /classification="rate-limit"/);
    redacted(stderr);
  });
});
