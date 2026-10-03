import assert from 'node:assert/strict';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import createCodexPluginLifecycleContribution, {
  type CodexPluginLifecycleDependencies,
} from '../agent/codex-plugin-lifecycle.ts';
import AgentSystemLifecycleRegistry from '../core/lifecycle-registry.ts';
import codexPluginRequirement from '../core/codex-plugin-metadata.ts';

const requirement = {
  spec: '@openclaw/codex@2026.9.7',
  version: '2026.9.7',
  minimumHostVersion: '2026.9.7',
};
const context = {
  manifest: { schemaVersion: 1 as const, agent: { id: 'first', runtime: 'codex' as const } },
  workspaceDir: '/workspace/first',
  runtime: 'openclaw' as const,
};

function fixture(initial: 'missing' | 'enabled' | 'disabled' = 'enabled') {
  const calls: string[][] = [];
  let state = initial;
  let lockCalls = 0;
  const record = {
    id: 'codex',
    version: requirement.version,
    origin: 'global',
    rootDir: '/profile/extensions/codex',
    enabled: initial === 'enabled',
    status: initial === 'enabled' ? 'loaded' : 'disabled',
  };
  const report = {
    plugin: record,
    install: { source: 'npm', version: requirement.version },
    compatibility: [] as { severity: string; code: string }[],
  };
  const metadata = {
    name: '@openclaw/codex',
    version: requirement.version,
    openclaw: {
      compat: { pluginApi: '>=2026.9.7' },
      install: { minHostVersion: '>=2026.5.1-beta.1' },
    },
  };
  const dependencies: CodexPluginLifecycleDependencies = {
    readConfig: () => ({}),
    async readRequirement() {
      return requirement;
    },
    async readPluginPackage(root) {
      assert.equal(root, record.rootDir);
      return metadata;
    },
    async withLock(run) {
      lockCalls++;
      return run();
    },
    async runOpenClawCommand(args) {
      calls.push(args);
      if (args[0] === '--version')
        return { code: 0, stdout: 'OpenClaw 2026.9.7 (release)', stderr: '' };
      if (args[1] === 'list')
        return {
          code: 0,
          stdout: JSON.stringify({ plugins: state === 'missing' ? [] : [record] }),
          stderr: '',
        };
      if (args[1] === 'inspect') return { code: 0, stdout: JSON.stringify(report), stderr: '' };
      if (args[1] === 'install' || args[1] === 'enable') {
        state = 'enabled';
        record.enabled = true;
        record.status = 'loaded';
        return { code: 0, stdout: 'applied', stderr: '' };
      }
      throw new Error('unexpected command');
    },
  };
  return {
    dependencies,
    record,
    report,
    metadata,
    calls,
    locks: () => lockCalls,
    contribution: () => createCodexPluginLifecycleContribution(dependencies),
    mutations: () =>
      calls.filter((args) =>
        ['install', 'enable', 'disable', 'update', 'uninstall'].includes(args[1] ?? ''),
      ),
  };
}

describe('agent/codex-plugin-lifecycle', () => {
  it('should skip openai models on the openclaw runtime without inspecting a missing plugin', async () => {
    const f = fixture('missing');
    f.dependencies.readConfig = () => ({
      agents: { entries: { first: { model: 'openai/gpt-6-sol' } } },
    });
    const native = {
      ...context,
      manifest: {
        ...context.manifest,
        agent: { id: 'first' },
        models: { default: { model: 'openai/gpt-6-sol', effort: 'high' as const } },
      },
    };
    assert.deepEqual(await f.contribution().inspect!(native), []);
    assert.deepEqual(await f.contribution().reconcile!(native), { outcomes: [] });
    assert.deepEqual(f.calls, []);
    assert.equal(f.locks(), 0);
  });

  it('should require explicit and inherited codex runtime bindings', async () => {
    const configurations: OpenClawConfig[] = [
      {
        agents: {
          entries: { first: { models: { 'openai/gpt-6-sol': { agentRuntime: { id: 'codex' } } } } },
        },
      },
      {
        agents: { defaults: { models: { 'openai/gpt-6-sol': { agentRuntime: { id: 'codex' } } } } },
      },
      {
        models: {
          providers: {
            openai: {
              baseUrl: 'https://example.invalid',
              agentRuntime: { id: 'codex' },
              models: [],
            },
          },
        },
      },
    ];
    for (const config of configurations) {
      const f = fixture('missing');
      f.dependencies.readConfig = () => config;
      const inherited = {
        ...context,
        manifest: {
          ...context.manifest,
          agent: { id: 'first' },
          models: { default: { model: 'openai/gpt-6-sol', effort: 'high' as const } },
        },
      };
      assert.equal((await f.contribution().inspect!(inherited))[0]?.code, 'codex-plugin-missing');
      assert.equal(
        (await f.contribution().reconcile!(inherited)).outcomes[0]?.code,
        'codex-plugin-installed',
      );
    }
  });

  it('should honor the bootstrap declaration and ignore unrelated shared installations', async () => {
    const f = fixture('disabled');
    f.record.version = '2026.9.6';
    f.report.install.version = '2026.9.6';
    const native = { ...context, manifest: { ...context.manifest, agent: { id: 'first' } } };
    assert.deepEqual(await f.contribution().inspect!(native), []);
    assert.deepEqual(await f.contribution().reconcile!(native), { outcomes: [] });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.mutations(), []);
    f.dependencies.readConfig = () => {
      throw new Error('fresh workspace has no runtime configuration');
    };
    assert.equal((await f.contribution().inspect!(context))[0]?.code, 'codex-plugin-conflict');
  });

  it('should respect an agent override of an inherited codex binding', async () => {
    const f = fixture('missing');
    f.dependencies.readConfig = () => ({
      agents: {
        defaults: { models: { 'openai/gpt-6-sol': { agentRuntime: { id: 'codex' } } } },
        entries: {
          first: { models: { 'openai/gpt-6-sol': { agentRuntime: { id: 'openclaw' } } } },
        },
      },
    });
    const native = {
      ...context,
      manifest: { ...context.manifest, agent: { id: 'first' } },
    };
    assert.deepEqual(await f.contribution().inspect!(native), []);
    assert.deepEqual(await f.contribution().reconcile!(native), { outcomes: [] });
    assert.deepEqual(f.calls, []);
  });

  it('should install the exact missing prerequisite and reuse it across repeated and second agent installs', async () => {
    const f = fixture('missing');
    const contribution = f.contribution();
    assert.equal(
      (await contribution.reconcile!(context)).outcomes[0]?.code,
      'codex-plugin-installed',
    );
    assert.equal((await contribution.reconcile!(context)).outcomes[0]?.status, 'unchanged');
    assert.equal(
      (
        await contribution.reconcile!({
          ...context,
          manifest: { ...context.manifest, agent: { id: 'second', runtime: 'codex' } },
          workspaceDir: '/workspace/second',
        })
      ).outcomes[0]?.status,
      'unchanged',
    );
    assert.deepEqual(f.mutations(), [
      ['plugins', 'install', 'npm:@openclaw/codex@2026.9.7', '--pin', '--accept-capabilities'],
    ]);
    assert.equal((await contribution.inspect!(context))[0]?.code, 'codex-plugin-ready');
  });

  it('should diagnose missing and disabled plugins without creating a lock or applying changes', async () => {
    for (const state of ['missing', 'disabled'] as const) {
      const f = fixture(state);
      assert.equal((await f.contribution().inspect!(context))[0]?.code, `codex-plugin-${state}`);
      assert.equal(f.locks(), 0);
      assert.deepEqual(f.mutations(), []);
    }
  });

  it('should enable a verified fresh install when the native installer preserves disabled state', async () => {
    const f = fixture('missing');
    const previous = f.dependencies.runOpenClawCommand;
    f.dependencies.runOpenClawCommand = async (args, cwd, signal) => {
      const result = await previous(args, cwd, signal);
      if (args[1] === 'install') {
        f.record.enabled = false;
        f.record.status = 'disabled';
      }
      return result;
    };
    assert.equal(
      (await f.contribution().reconcile!(context)).outcomes[0]?.code,
      'codex-plugin-installed',
    );
    assert.deepEqual(f.mutations(), [
      ['plugins', 'install', 'npm:@openclaw/codex@2026.9.7', '--pin', '--accept-capabilities'],
      ['plugins', 'enable', 'codex', '--accept-capabilities'],
    ]);
    assert.equal((await f.contribution().inspect!(context))[0]?.code, 'codex-plugin-ready');
  });

  it('should enable only a matching managed installation', async () => {
    const f = fixture('disabled');
    assert.equal(
      (await f.contribution().reconcile!(context)).outcomes[0]?.code,
      'codex-plugin-enabled',
    );
    assert.deepEqual(f.mutations(), [['plugins', 'enable', 'codex', '--accept-capabilities']]);
  });

  it('should reject incompatible and unknown hosts before locking or changing shared state', async () => {
    for (const host of ['2026.9.6', 'unknown', '2026.9.7-beta.1']) {
      const f = fixture('missing');
      f.dependencies.runOpenClawCommand = async () => ({ code: 0, stdout: host, stderr: '' });
      await assert.rejects(f.contribution().reconcile!(context), {
        code: 'codex-plugin-host-incompatible',
      });
      assert.equal(f.locks(), 0);
      assert.deepEqual(f.mutations(), []);
    }
  });

  it('should block conflicting lower and higher shared versions without replacement', async () => {
    for (const version of ['2026.9.6', '2026.9.8']) {
      const f = fixture('disabled');
      f.record.version = version;
      f.report.install.version = version;
      const finding = (await f.contribution().inspect!(context))[0]!;
      assert.equal(finding.code, 'codex-plugin-conflict');
      assert.ok(finding.message.includes(version));
      assert.ok(finding.message.includes(requirement.spec));
      await assert.rejects(f.contribution().reconcile!(context), { code: 'codex-plugin-conflict' });
      assert.deepEqual(f.mutations(), []);
    }
  });

  it('should reject unmanaged sources, misleading receipts, package identity conflicts, and incompatible plugin metadata', async () => {
    const changes = [
      (f: ReturnType<typeof fixture>) => {
        f.record.origin = 'workspace';
      },
      (f: ReturnType<typeof fixture>) => {
        f.report.install.source = 'path';
      },
      (f: ReturnType<typeof fixture>) => {
        f.report.install.source = 'archive';
      },
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.report.install, {
          artifactKind: 'tarball',
          sourcePath: '/local/codex.tgz',
        });
      },
      (f: ReturnType<typeof fixture>) => {
        f.report.install.version = '2026.9.6';
      },
      (f: ReturnType<typeof fixture>) => {
        f.metadata.name = '@other/codex';
      },
      (f: ReturnType<typeof fixture>) => {
        f.metadata.openclaw.compat.pluginApi = '>=2026.9.8';
      },
      (f: ReturnType<typeof fixture>) => {
        f.metadata.openclaw.compat.pluginApi = '';
      },
      (f: ReturnType<typeof fixture>) => {
        f.report.compatibility.push({ severity: 'error', code: 'incompatible' });
      },
    ];
    for (const change of changes) {
      const f = fixture('disabled');
      change(f);
      await assert.rejects(f.contribution().reconcile!(context));
      assert.deepEqual(f.mutations(), []);
    }
  });

  it('should preserve a concurrent installation discovered after acquiring the profile lock', async () => {
    const f = fixture('missing');
    f.dependencies.withLock = async (run) => {
      f.record.version = '2026.9.8';
      f.report.install.version = '2026.9.8';
      const previous = f.dependencies.runOpenClawCommand;
      f.dependencies.runOpenClawCommand = async (args, cwd, signal) =>
        args[1] === 'list'
          ? { code: 0, stdout: JSON.stringify({ plugins: [f.record] }), stderr: '' }
          : previous(args, cwd, signal);
      return run();
    };
    await assert.rejects(f.contribution().reconcile!(context), { code: 'codex-plugin-conflict' });
    assert.deepEqual(f.mutations(), []);
  });

  it('should retain bounded sanitized installer failure evidence without leaking upstream prose', async () => {
    const f = fixture('missing');
    const previous = f.dependencies.runOpenClawCommand;
    f.dependencies.runOpenClawCommand = async (args, cwd, signal) =>
      args[1] === 'install'
        ? {
            code: 19,
            stdout: '',
            stderr: `fetch failed secret-token private-path ${'x'.repeat(1000)}`,
          }
        : previous(args, cwd, signal);
    await assert.rejects(f.contribution().reconcile!(context), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exit=19; category=transport/);
      assert.ok(!error.message.includes('secret-token'));
      assert.ok(error.message.length < 500);
      return true;
    });
  });

  it('should reject missing convergence after a successful installer exit', async () => {
    const f = fixture('missing');
    const previous = f.dependencies.runOpenClawCommand;
    f.dependencies.runOpenClawCommand = async (args, cwd, signal) =>
      args[1] === 'install' ? { code: 0, stdout: '', stderr: '' } : previous(args, cwd, signal);
    await assert.rejects(f.contribution().reconcile!(context), {
      code: 'codex-plugin-verification-failed',
    });
  });

  it('should exclude the openclaw prerequisite from standalone codex', async () => {
    const f = fixture('missing');
    const standalone = { ...context, runtime: 'codex' as const };
    assert.deepEqual(await f.contribution().inspect!(standalone), []);
    assert.deepEqual(await f.contribution().reconcile!(standalone), { outcomes: [] });
    assert.equal(f.locks(), 0);
    assert.deepEqual(f.calls, []);
  });

  it('should preserve cancellation instead of reporting it as an inspection failure', async () => {
    const f = fixture();
    const signal = AbortSignal.abort(new Error('cancelled'));
    const cancelled = { ...context, signal };
    await assert.rejects(f.contribution().inspect!(cancelled), /cancelled/);
    assert.deepEqual(f.calls, []);
  });

  it('should run the shared prerequisite before host setup, path, agent setup, and models', async () => {
    const calls: string[] = [];
    const registry = new AgentSystemLifecycleRegistry(
      ['models', 'path', 'agent', 'codex-plugin'].map((id) => ({
        id,
        isConfigured: () => true,
        async reconcile() {
          calls.push(id);
          return { outcomes: [] };
        },
      })),
      {
        async inspect() {
          return [];
        },
        async reconcile(_context, phase) {
          calls.push(`setup-${phase}`);
          return { outcomes: [], warnings: [] };
        },
      },
    );
    const configured = {
      ...context,
      manifest: {
        ...context.manifest,
        setupHost: {
          steps: [
            {
              id: 'host',
              apply: {
                kind: 'shell' as const,
                script: 'true',
                shell: 'bash' as const,
                timeoutSeconds: 10,
              },
            },
          ],
        },
        setup: {
          steps: [
            {
              id: 'agent',
              apply: {
                kind: 'shell' as const,
                script: 'true',
                shell: 'bash' as const,
                timeoutSeconds: 10,
              },
            },
          ],
        },
      },
    };
    await registry.reconcile(configured);
    assert.deepEqual(calls, [
      'codex-plugin',
      'setup-host',
      'agent',
      'path',
      'setup-agent',
      'models',
    ]);
    calls.length = 0;
    await registry.reconcile(configured, { skipSetup: true });
    assert.deepEqual(calls, ['codex-plugin', 'models', 'path', 'agent']);
  });

  it('should require a release-owned exact codex spec and reject tags, ranges, and other packages', () => {
    for (const spec of [
      '@openclaw/codex@latest',
      '@openclaw/codex@^2026.9.7',
      '@other/codex@2026.9.7',
      '@openclaw/codex@v2026.9.7',
    ])
      assert.equal(
        codexPluginRequirement({
          openclaw: {
            agentSystem: { codexPlugin: spec },
            compat: { minGatewayVersion: '2026.9.7' },
          },
        }),
        undefined,
      );
    assert.deepEqual(
      codexPluginRequirement({
        openclaw: {
          agentSystem: { codexPlugin: requirement.spec },
          compat: { minGatewayVersion: requirement.minimumHostVersion },
        },
      }),
      requirement,
    );
  });
});
