import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import AgentLifecycleApproval from '../agent/lifecycle-approval.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { intakeFixture } from './github-intake-fixture.ts';

async function fixture() {
  const workspaceDir = await realpath(tmpdir());
  const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
    status: 'loaded',
    path: `${workspaceDir}/agent.yaml`,
    digest: 'a'.repeat(64),
    scope: { workspaceDir },
    diagnostics: [],
    validationChecks: [],
    manifest: {
      schemaVersion: 1,
      agent: { id: 'owner-agent' },
      github: {
        username: 'receiver',
        notifications: { ...intakeFixture().policy, runtimes: ['openclaw'] },
      },
    },
  };
  const calls: unknown[] = [];
  let current = true;
  const approval = new AgentLifecycleApproval({
    manifestService: {
      loadForAgentId: async () => loaded,
      withSnapshot: async (_snapshot, _signal, operation) => operation(),
    },
    doctorService: {
      inspect: async () => {
        calls.push('doctor');
        return { agentId: 'owner-agent', workspaceDir, findings: [], status: 'healthy' };
      },
    },
    installService: {
      install: async (input) => {
        input.assertEnrollmentCurrent?.();
        calls.push(input.sessionDispatchConsent);
        return { agentId: 'owner-agent', workspaceDir, outcomes: [], warnings: [] };
      },
    },
  });
  const context = {
    agentId: 'owner-agent',
    sessionKey: 'agent:owner-agent:direct',
    sessionId: 'session',
    toolCallId: 'call',
    requester: { senderIsOwner: true },
  };
  const tool = {
    ...context,
    workspaceDir,
    senderIsOwner: true,
    assertInvocationCurrent() {
      if (!current) throw new Error('retired');
    },
  };
  return {
    approval,
    context,
    tool,
    calls,
    loaded,
    retire() {
      current = false;
    },
  };
}

describe('agent/session-dispatch-approval', () => {
  it('should disclose consumers and grants and pass one owner-approved enrollment authority', async () => {
    const f = await fixture();
    const request = await f.approval.request('agent_system_install', {}, f.context);
    assert.ok(request.requireApproval);
    for (const signal of [
      'issue assignments',
      'operator.read',
      'operator.write',
      'broader',
      'blocked',
    ])
      assert.ok(request.requireApproval.description.includes(signal));
    assert.ok(request.requireApproval.description.length <= 512);
    assert.deepEqual(f.calls, []);
    request.requireApproval.onResolution('allow-once');
    await f.approval.execute('agent_system_install', {}, 'call', f.tool);
    assert.deepEqual(f.calls, [true]);
    await assert.rejects(f.approval.execute('agent_system_install', {}, 'call', f.tool), {
      code: 'approval_denied',
    });
  });

  it('should disclose manual-only enrollment and bind its option to the approved invocation', async () => {
    const f = await fixture();
    delete f.loaded.manifest.github!.notifications;
    const params = { manualSessionDispatch: true };
    const request = await f.approval.request('agent_system_install', params, f.context);
    assert.ok(request.requireApproval?.description.includes('manual issue launch'));
    assert.ok(request.requireApproval?.description.includes('operator.write'));
    request.requireApproval!.onResolution('allow-once');
    await assert.rejects(f.approval.execute('agent_system_install', {}, 'call', f.tool), {
      code: 'approval_denied',
    });
    assert.deepEqual(f.calls, []);
    const retry = await f.approval.request('agent_system_install', params, f.context);
    retry.requireApproval!.onResolution('allow-once');
    await f.approval.execute('agent_system_install', params, 'call', f.tool);
    assert.deepEqual(f.calls, [true]);
  });

  it('should reject a non-owner before requesting enrollment approval', async () => {
    const f = await fixture();
    await assert.rejects(
      f.approval.request(
        'agent_system_install',
        {},
        { ...f.context, requester: { senderIsOwner: false } },
      ),
      { code: 'approval_denied' },
    );
    assert.deepEqual(f.calls, []);
  });

  it('should reject lost owner authority and retired invocations after approval', async () => {
    for (const kind of ['owner', 'retired']) {
      const f = await fixture();
      const request = await f.approval.request('agent_system_install', {}, f.context);
      request.requireApproval!.onResolution('allow-once');
      if (kind === 'owner') f.tool.senderIsOwner = false;
      else f.retire();
      await assert.rejects(f.approval.execute('agent_system_install', {}, 'call', f.tool));
      assert.deepEqual(f.calls, []);
    }
  });

  it('should keep denied enrollment inert and doctor separate from enrollment consent', async () => {
    const f = await fixture();
    const request = await f.approval.request('agent_system_install', {}, f.context);
    request.requireApproval!.onResolution('deny');
    await assert.rejects(f.approval.execute('agent_system_install', {}, 'call', f.tool));
    const doctor = await f.approval.request('agent_system_doctor', {}, f.context);
    assert.ok(!doctor.requireApproval!.description.includes('operator.write'));
    doctor.requireApproval!.onResolution('allow-once');
    await f.approval.execute('agent_system_doctor', {}, 'call', f.tool);
    assert.deepEqual(f.calls, ['doctor']);
  });
});
