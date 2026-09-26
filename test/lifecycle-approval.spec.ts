import assert from 'node:assert/strict';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { Value } from 'typebox/value';

import createInstallTool from '../tools/install/tool.ts';
import createDoctorTool from '../tools/doctor/tool.ts';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentLifecycleApproval from '../agent/lifecycle-approval.ts';
import AgentInstallService from '../agent/install-service.ts';
import AgentDoctorService from '../agent/doctor-service.ts';
import SetupLifecycleService from '../agent/setup-lifecycle.ts';
import AgentSystemLifecycleRegistry from '../core/lifecycle-registry.ts';
import AgentManifestService from '../manifest/service.ts';
import { lifecycleToolNames, type LifecycleToolName } from '../agent/lifecycle-tool-contract.ts';

const roots: string[] = [];
const manifest = `schema-version: 1
agent:
  id: data
environment:
  set:
    TOKEN:
      from-op: op://vault/item/password
setup:
  steps:
    - id: sample
      check: check-approved
      apply: apply-approved
`;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lifecycle-approval-')));
  roots.push(root);
  await writeFile(join(root, 'agent.yaml'), manifest);
  const workspaces: Record<string, string> = { data: root };
  const calls: string[] = [];
  const rebuilds: boolean[] = [];
  const controller = new AbortController();
  const context = {
    agentId: 'data',
    sessionKey: 'agent:data:test',
    sessionId: 'session',
    toolCallId: 'call',
    abortSignal: controller.signal,
  };
  const service = new AgentManifestService({
    getConfig: () => ({}),
    logger: { info() {}, warn() {}, error() {} },
    parseSessionAgentId: () => 'data',
    resolveAgentWorkspaceDir: (_config, agent) => workspaces[agent]!,
  });
  let afterInspect: (() => Promise<void>) | undefined;
  const lifecycleRegistry = new AgentSystemLifecycleRegistry(
    [
      {
        id: 'agent',
        isConfigured: () => true,
        async inspect() {
          calls.push('inspect');
          await afterInspect?.();
          return [];
        },
        async reconcile(input) {
          calls.push('reconcile');
          rebuilds.push(input.rebuildCodexPath === true);
          return { outcomes: [] };
        },
      },
    ],
    new SetupLifecycleService({
      async run(command, _target, signal) {
        assert.equal(signal?.aborted, false);
        calls.push(command.kind === 'shell' ? command.script : command.executable);
        return { exitCode: 0, timedOut: false, truncated: false };
      },
    }),
  );
  const approval = new AgentLifecycleApproval({
    manifestService: service,
    doctorService: new AgentDoctorService({ lifecycleRegistry }),
    installService: new AgentInstallService({
      lifecycleRegistry,
      credentialManager: {
        async validateStoredForInstall() {
          calls.push('credentials');
          return { status: 'ready' };
        },
      },
    }),
  });
  return {
    root,
    service,
    calls,
    rebuilds,
    context,
    controller,
    approval,
    async request(name: LifecycleToolName, params: Record<string, unknown>, target = context) {
      const result = await approval.request(name, params, target);
      assert.ok(result.requireApproval, 'a new operation must require consent');
      return { requireApproval: result.requireApproval };
    },
    workspaces,
    toolContext: { ...context, workspaceDir: root },
    afterInspect(callback: () => Promise<void>) {
      afterInspect = callback;
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent/lifecycle-approval', () => {
  for (const name of lifecycleToolNames) {
    it(`should revalidate an approved ${name} across both hooks and execute only once`, async () => {
      const f = await fixture();
      const request = await f.request(name, {}, f.context);
      request.requireApproval.onResolution('allow-once');
      const executionHook = new AbortController();
      assert.deepEqual(
        await f.approval.request(name, {}, { ...f.context, abortSignal: executionHook.signal }),
        {},
      );
      assert.equal(f.calls.length, 0);
      await f.approval.execute(name, {}, 'call', f.toolContext);
      const completed = [...f.calls];
      assert.ok(completed.includes('check-approved'));
      await assert.rejects(f.approval.execute(name, {}, 'call', f.toolContext), {
        code: 'approval_denied',
      });
      assert.deepEqual(f.calls, completed);
      await f.request(name, {}, f.context);
      request.requireApproval.onResolution('allow-once');
      await assert.rejects(f.approval.execute(name, {}, 'call', f.toolContext), {
        code: 'approval_denied',
      });
      assert.deepEqual(f.calls, completed);
    });

    it(`should register ${name} with its own schema and execute once only after approval`, async () => {
      const f = await fixture();
      const definition = (name === 'agent_system_install' ? createInstallTool : createDoctorTool)(
        () => f.approval,
      );
      assert.deepEqual(definition.commands, []);
      assert.deepEqual(definition.toolNames, [name]);
      let factory: Parameters<OpenClawPluginApi['registerTool']>[0] | undefined;
      definition.registerTools(
        {
          registerTool(value) {
            factory = value;
          },
        },
        {} as never,
      );
      assert.equal(typeof factory, 'function');
      if (typeof factory !== 'function') throw new Error('missing native tool factory');
      const native = await factory(f.toolContext);
      assert.ok(native && !Array.isArray(native));
      assert.equal(native.name, name);
      assert.equal(Value.Check(native.parameters, {}), true);
      const params = { timeoutMs: 600_000 };
      assert.equal(Value.Check(native.parameters, params), true);
      for (const timeoutMs of [0, -1, 1.5, 600_001, '600000']) {
        assert.equal(Value.Check(native.parameters, { timeoutMs }), false);
      }
      assert.equal(Value.Check(native.parameters, { agent: 'other' }), false);
      assert.equal(
        Value.Check(native.parameters, { skipSetup: true }),
        name === 'agent_system_install',
      );
      await assert.rejects(native.execute('call', params, f.controller.signal), {
        code: 'approval_denied',
      });
      assert.deepEqual(f.calls, []);
      const request = await f.request(name, params, f.context);
      assert.equal(request.requireApproval.timeoutMs, 120_000);
      assert.deepEqual(request.requireApproval.allowedDecisions, ['allow-once', 'deny']);
      assert.ok(request.requireApproval.description.includes(f.root));
      assert.ok(request.requireApproval.description.includes('data'));
      assert.deepEqual(f.calls, []);
      request.requireApproval.onResolution('allow-once');
      await native.execute('call', params, f.controller.signal);
      assert.deepEqual(
        f.calls,
        name === 'agent_system_install'
          ? ['credentials', 'reconcile', 'inspect', 'check-approved']
          : ['inspect', 'check-approved'],
      );
      await assert.rejects(native.execute('call', params, f.controller.signal), {
        code: 'approval_denied',
      });
    });

    for (const decision of ['deny', 'timeout', 'cancelled', 'allow-always', 'unknown', undefined]) {
      it(`should execute nothing for ${name} with ${decision ?? 'unavailable approval'}`, async () => {
        const f = await fixture();
        const request = await f.request(name, {}, f.context);
        if (decision) request.requireApproval.onResolution(decision);
        await assert.rejects(f.approval.execute(name, {}, 'call', f.toolContext), {
          code: 'approval_denied',
        });
        assert.deepEqual(f.calls, []);
      });
    }
  }

  it('should reject a tool call when the host hook did not run', async () => {
    const f = await fixture();
    await assert.rejects(f.approval.execute('agent_system_install', {}, 'call', f.toolContext), {
      code: 'approval_denied',
    });
    assert.deepEqual(f.calls, []);
  });

  it('should require new consent when a repeated hook changes the operation binding', async () => {
    for (const change of [
      'options',
      'manifest',
      'workspace',
      'session',
      'session-key',
      'call',
      'operation',
    ]) {
      const f = await fixture();
      const original = await f.request('agent_system_install', {}, f.context);
      original.requireApproval.onResolution('allow-once');
      if (change === 'manifest')
        await writeFile(
          join(f.root, 'agent.yaml'),
          manifest.replace('check-approved', 'changed-check'),
        );
      if (change === 'workspace') {
        const other = await fixture();
        f.workspaces.data = other.root;
      }
      const context = {
        ...f.context,
        ...(change === 'session' ? { sessionId: 'other' } : {}),
        ...(change === 'session-key' ? { sessionKey: 'agent:data:other' } : {}),
        ...(change === 'call' ? { toolCallId: 'other' } : {}),
      };
      const name = change === 'operation' ? 'agent_system_doctor' : 'agent_system_install';
      const params = change === 'options' ? { skipSetup: true } : {};
      await f.request(name, params, context);
      original.requireApproval.onResolution('allow-once');
      await assert.rejects(
        f.approval.execute(name, params, context.toolCallId, {
          ...context,
          workspaceDir: f.workspaces.data,
        }),
        { code: 'approval_denied' },
      );
      assert.deepEqual(f.calls, []);
      f.controller.abort();
    }
  });

  it('should preserve cancellation from either hook before and during execution', async () => {
    for (const hook of ['approval', 'execution']) {
      for (const duringExecution of [false, true]) {
        const f = await fixture();
        const executionHook = new AbortController();
        const request = await f.request('agent_system_doctor', {}, f.context);
        request.requireApproval.onResolution('allow-once');
        assert.deepEqual(
          await f.approval.request(
            'agent_system_doctor',
            {},
            { ...f.context, abortSignal: executionHook.signal },
          ),
          {},
        );
        const controller = hook === 'approval' ? f.controller : executionHook;
        if (duringExecution)
          f.afterInspect(async () => {
            controller.abort();
          });
        else controller.abort();
        await assert.rejects(f.approval.execute('agent_system_doctor', {}, 'call', f.toolContext));
        assert.deepEqual(f.calls, duringExecution ? ['inspect'] : []);
      }
    }
  });

  it('should discard consent when a repeated hook finds an invalid manifest', async () => {
    const f = await fixture();
    const request = await f.request('agent_system_doctor', {}, f.context);
    request.requireApproval.onResolution('allow-once');
    await writeFile(join(f.root, 'agent.yaml'), 'invalid: [');
    await assert.rejects(f.approval.request('agent_system_doctor', {}, f.context));
    await writeFile(join(f.root, 'agent.yaml'), manifest);
    await f.request('agent_system_doctor', {}, f.context);
    await assert.rejects(f.approval.execute('agent_system_doctor', {}, 'call', f.toolContext), {
      code: 'approval_denied',
    });
    assert.deepEqual(f.calls, []);
  });

  it('should not extend consent expiry when a second hook revalidates it', async () => {
    const f = await fixture();
    const request = await f.request('agent_system_doctor', {}, f.context);
    request.requireApproval.onResolution('allow-once');
    const now = Date.now;
    const deadline = now() + request.requireApproval.timeoutMs;
    try {
      Date.now = () => deadline - 1000;
      assert.deepEqual(await f.approval.request('agent_system_doctor', {}, f.context), {});
      Date.now = () => deadline + 1;
      await f.request('agent_system_doctor', {}, f.context);
      await assert.rejects(f.approval.execute('agent_system_doctor', {}, 'call', f.toolContext), {
        code: 'approval_denied',
      });
      assert.deepEqual(f.calls, []);
    } finally {
      Date.now = now;
      f.controller.abort();
    }
  });

  it('should bind skip setup to the approved install without running checks', async () => {
    const f = await fixture();
    const request = await f.request('agent_system_install', { skipSetup: true }, f.context);
    assert.match(request.requireApproval.description, /skip setup/i);
    request.requireApproval.onResolution('allow-once');
    await f.approval.execute('agent_system_install', { skipSetup: true }, 'call', f.toolContext);
    assert.deepEqual(f.calls, ['credentials', 'reconcile']);
  });

  it('should bind a Codex PATH rebuild to the approved install', async () => {
    const f = await fixture();
    const params = { rebuildCodexPath: true };
    const request = await f.request('agent_system_install', params, f.context);
    assert.match(request.requireApproval.description, /replace the saved Codex PATH baseline/iu);
    request.requireApproval.onResolution('allow-once');

    await f.approval.execute('agent_system_install', params, 'call', f.toolContext);

    assert.deepEqual(f.calls, ['credentials', 'reconcile', 'inspect', 'check-approved']);
    assert.deepEqual(f.rebuilds, [true]);
  });

  it('should reject a Codex PATH rebuild that was not approved', async () => {
    const f = await fixture();
    const request = await f.request('agent_system_install', {}, f.context);
    request.requireApproval.onResolution('allow-once');

    await assert.rejects(
      f.approval.execute('agent_system_install', { rebuildCodexPath: true }, 'call', f.toolContext),
      { code: 'approval_denied' },
    );
    assert.deepEqual(f.calls, []);
  });

  it('should reject consent after its deadline without waiting for timer cleanup', async () => {
    const f = await fixture();
    const request = await f.request('agent_system_install', {}, f.context);
    request.requireApproval.onResolution('allow-once');
    const now = Date.now;
    const future = now() + request.requireApproval.timeoutMs + 1;
    try {
      Date.now = () => future;
      await assert.rejects(f.approval.execute('agent_system_install', {}, 'call', f.toolContext), {
        code: 'approval_denied',
      });
      assert.deepEqual(f.calls, []);
    } finally {
      Date.now = now;
    }
  });

  it('should stop after cancellation without running subsequent doctor checks', async () => {
    const f = await fixture();
    f.afterInspect(async () => {
      f.controller.abort();
    });
    const request = await f.request('agent_system_doctor', {}, f.context);
    request.requireApproval.onResolution('allow-once');
    await assert.rejects(f.approval.execute('agent_system_doctor', {}, 'call', f.toolContext));
    assert.deepEqual(f.calls, ['inspect']);
  });

  it('should reject changed options, manifests, workspaces, sessions, and agents', async () => {
    for (const change of [
      'options',
      'manifest',
      'workspace',
      'session',
      'agent',
      'call',
      'operation',
    ]) {
      const f = await fixture();
      const request = await f.request('agent_system_install', {}, f.context);
      request.requireApproval.onResolution('allow-once');
      if (change === 'manifest')
        await writeFile(
          join(f.root, 'agent.yaml'),
          manifest.replace('apply-approved', 'unapproved'),
        );
      const context = {
        ...f.toolContext,
        ...(change === 'workspace' ? { workspaceDir: tmpdir() } : {}),
        ...(change === 'session' ? { sessionId: 'other' } : {}),
        ...(change === 'agent' ? { agentId: 'other' } : {}),
      };
      await assert.rejects(
        f.approval.execute(
          change === 'operation' ? 'agent_system_doctor' : 'agent_system_install',
          change === 'options' ? { skipSetup: true } : {},
          change === 'call' ? 'other' : 'call',
          context,
        ),
      );
      assert.deepEqual(f.calls, []);
      f.controller.abort();
    }
  });

  it('should stop pending and resolved approvals when the turn is cancelled', async () => {
    for (const resolved of [false, true]) {
      const f = await fixture();
      const request = await f.request('agent_system_install', {}, f.context);
      if (resolved) request.requireApproval.onResolution('allow-once');
      f.controller.abort();
      request.requireApproval.onResolution('allow-once');
      await assert.rejects(f.approval.execute('agent_system_install', {}, 'call', f.toolContext));
      assert.deepEqual(f.calls, []);
    }
  });

  it('should prevent a concurrent retry from consuming an older approval', async () => {
    const f = await fixture();
    const old = await f.request('agent_system_doctor', {}, f.context);
    const current = await f.request('agent_system_doctor', {}, f.context);
    old.requireApproval.onResolution('allow-once');
    await assert.rejects(f.approval.execute('agent_system_doctor', {}, 'call', f.toolContext));
    current.requireApproval.onResolution('allow-once');
    assert.deepEqual(f.calls, []);
  });

  it('should stop before later checks when the manifest changes during inspection', async () => {
    const f = await fixture();
    f.afterInspect(() =>
      writeFile(join(f.root, 'agent.yaml'), manifest.replace('check-approved', 'unapproved')),
    );
    const request = await f.request('agent_system_doctor', {}, f.context);
    request.requireApproval.onResolution('allow-once');
    await assert.rejects(f.approval.execute('agent_system_doctor', {}, 'call', f.toolContext));
    assert.deepEqual(f.calls, ['inspect']);
  });

  it('should bind nested manifest consumers without changing unrelated operator loads', async () => {
    const f = await fixture();
    const loaded = await f.service.loadForAgentId('data');
    assert.equal(loaded.status, 'loaded');
    await f.service.withSnapshot(loaded, f.controller.signal, async () => {
      await writeFile(join(f.root, 'agent.yaml'), manifest.replace('apply-approved', 'unapproved'));
      const changed = await f.service.loadForAgentId('data');
      assert.equal(changed.status, 'invalid');
      assert.ok(changed.diagnostics.some(({ code }) => code === 'manifest-approval-changed'));
    });
    assert.equal((await f.service.loadForAgentId('data')).status, 'loaded');
  });

  it('should reject caller-selected identities and cli consent flags', async () => {
    const f = await fixture();
    for (const params of [
      { agentId: 'other' },
      { workspaceDir: '/other' },
      { yes: true },
      { nonInteractive: true },
    ]) {
      await assert.rejects(f.request('agent_system_install', params, f.context));
    }
    assert.deepEqual(f.calls, []);
  });
});
