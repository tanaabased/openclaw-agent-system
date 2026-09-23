import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentLifecycleApproval from '../agent/lifecycle-approval.ts';
import AgentInstallService from '../agent/install-service.ts';
import AgentDoctorService from '../agent/doctor-service.ts';
import SetupLifecycleService from '../agent/setup-lifecycle.ts';
import AgentSystemLifecycleRegistry from '../core/lifecycle-registry.ts';
import AgentManifestService from '../manifest/service.ts';
import { lifecycleToolNames } from '../tools/lifecycle/schema.ts';

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
        async reconcile() {
          calls.push('reconcile');
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
    context,
    controller,
    approval,
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
    it(`should execute ${name} once only after approval`, async () => {
      const f = await fixture();
      const request = await f.approval.request(name, {}, f.context);
      assert.deepEqual(request.requireApproval.allowedDecisions, ['allow-once', 'deny']);
      assert.ok(request.requireApproval.description.includes(f.root));
      assert.ok(request.requireApproval.description.includes('data'));
      assert.deepEqual(f.calls, []);
      request.requireApproval.onResolution('allow-once');
      await f.approval.execute(name, {}, 'call', f.toolContext);
      assert.deepEqual(
        f.calls,
        name === 'agent_system_install'
          ? ['credentials', 'reconcile', 'inspect', 'check-approved']
          : ['inspect', 'check-approved'],
      );
      await assert.rejects(f.approval.execute(name, {}, 'call', f.toolContext), {
        code: 'approval_denied',
      });
    });

    for (const decision of ['deny', 'timeout', 'cancelled', 'allow-always', 'unknown', undefined]) {
      it(`should execute nothing for ${name} with ${decision ?? 'unavailable approval'}`, async () => {
        const f = await fixture();
        const request = await f.approval.request(name, {}, f.context);
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

  it('should bind skip setup to the approved install without running checks', async () => {
    const f = await fixture();
    const request = await f.approval.request(
      'agent_system_install',
      { skipSetup: true },
      f.context,
    );
    assert.match(request.requireApproval.description, /skip setup/i);
    request.requireApproval.onResolution('allow-once');
    await f.approval.execute('agent_system_install', { skipSetup: true }, 'call', f.toolContext);
    assert.deepEqual(f.calls, ['credentials', 'reconcile']);
  });

  it('should reject consent after its deadline without waiting for timer cleanup', async () => {
    const f = await fixture();
    const request = await f.approval.request('agent_system_install', {}, f.context);
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
    const request = await f.approval.request('agent_system_doctor', {}, f.context);
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
      const request = await f.approval.request('agent_system_install', {}, f.context);
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
      const request = await f.approval.request('agent_system_install', {}, f.context);
      if (resolved) request.requireApproval.onResolution('allow-once');
      f.controller.abort();
      request.requireApproval.onResolution('allow-once');
      await assert.rejects(f.approval.execute('agent_system_install', {}, 'call', f.toolContext));
      assert.deepEqual(f.calls, []);
    }
  });

  it('should prevent a concurrent retry from consuming an older approval', async () => {
    const f = await fixture();
    const old = await f.approval.request('agent_system_doctor', {}, f.context);
    const current = await f.approval.request('agent_system_doctor', {}, f.context);
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
    const request = await f.approval.request('agent_system_doctor', {}, f.context);
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
      await assert.rejects(f.approval.request('agent_system_install', params, f.context));
    }
    assert.deepEqual(f.calls, []);
  });
});
