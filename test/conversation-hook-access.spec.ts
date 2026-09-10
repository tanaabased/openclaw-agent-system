import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import ConversationHookAccess, {
  conversationHookSetting,
  inspectConversationHookPolicy,
  inspectConversationHookReport,
  inspectRunningConversationHook,
} from '../core/conversation-hook-access.ts';
import AgentDoctorService from '../agent/doctor-service.ts';
import AgentSystemLifecycleRegistry from '../core/lifecycle-registry.ts';
import createNotificationLifecycleContribution from '../channels/github/runtime/lifecycle-contribution.ts';

function config(access?: boolean): OpenClawConfig {
  return {
    gateway: { reload: { mode: 'off' } },
    plugins: {
      entries: {
        other: { enabled: true, config: { keep: 'unchanged' } },
        'agent-system': {
          enabled: true,
          config: {},
          hooks: {
            ...(access === undefined ? {} : { allowConversationAccess: access }),
            timeoutMs: 900,
          },
        },
      },
    },
  };
}

function report(registered = true) {
  return {
    code: 0,
    stderr: '',
    stdout: JSON.stringify({
      plugin: { id: 'agent-system', enabled: true, status: 'loaded' },
      policy: { allowConversationAccess: true },
      typedHooks: registered ? [{ name: 'before_prompt_build' }, { name: 'before_agent_run' }] : [],
      diagnostics: [],
    }),
  };
}

function fixture(access?: boolean, registered = true) {
  let current = config(access);
  let mutations = 0;
  let inspections = 0;
  const service = new ConversationHookAccess({
    readConfig: () => current,
    async mutateConfigFile(input) {
      mutations++;
      assert.equal(input.base, 'source');
      assert.deepEqual(input.afterWrite, { mode: 'auto' });
      const next = structuredClone(current);
      const result = input.mutate(next);
      current = next;
      return { result };
    },
    async inspectPlugin(workspace) {
      assert.equal(workspace, '/workspace');
      inspections++;
      return report(registered);
    },
  });
  return {
    service,
    current: () => current,
    mutations: () => mutations,
    inspections: () => inspections,
  };
}

describe('core/conversation-hook-access', () => {
  for (const access of [undefined, false]) {
    it(`should report ${access === false ? 'denied' : 'unset'} consent without mutating configuration`, async () => {
      const state = fixture(access);
      const before = structuredClone(state.current());
      const finding = await state.service.inspect('/workspace');
      assert.equal(finding.status, 'blocked');
      assert.equal(finding.code, 'github-notification-hook-access-required');
      assert.ok(finding.message.includes(conversationHookSetting));
      assert.match(finding.remediation ?? '', /openclaw agent-system install/u);
      assert.deepEqual(state.current(), before);
      assert.equal(state.mutations(), 0);
      assert.equal(state.inspections(), 0);
    });

    it(`should reconcile ${access === false ? 'denied' : 'unset'} consent only on install and preserve unrelated configuration`, async () => {
      const state = fixture(access);
      const expected = config(true);
      const result = await state.service.reconcile('/workspace');
      assert.equal(result.status, 'updated');
      assert.match(result.message, /Gateway.*reload/u);
      assert.deepEqual(state.current(), expected);
      assert.equal(state.inspections(), 1);
      assert.equal((await state.service.reconcile('/workspace')).status, 'unchanged');
      assert.equal(state.mutations(), 1);
      assert.equal(state.inspections(), 2);
    });
  }

  it('should block doctor even when routing and polling could otherwise report healthy', async () => {
    const state = fixture();
    const contribution = createNotificationLifecycleContribution({
      hookAccess: state.service,
      routingService: {
        inspect: async () => ({
          kind: 'noop',
          code: 'notification-routing-ready',
          message: 'ready',
        }),
        reconcile: async () => {
          throw new Error('doctor must not reconcile');
        },
      },
    });
    const doctor = new AgentDoctorService({
      lifecycleRegistry: new AgentSystemLifecycleRegistry([contribution]),
    });
    const result = await doctor.inspect({
      manifest: {
        schemaVersion: 1,
        agent: { id: 'data' },
        github: {
          notifications: { assignmentTypes: ['issue'], approvedActors: [], intervalMinutes: 5 },
        },
      },
      workspaceDir: '/workspace',
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.findings[0]?.component, 'github-notifications');
    assert.equal(result.findings[0]?.code, 'github-notification-hook-access-required');
    assert.equal(state.mutations(), 0);
  });

  it('should fail installation when the permission write succeeds but registration is missing', async () => {
    const state = fixture(undefined, false);
    await assert.rejects(state.service.reconcile('/workspace'), {
      code: 'github-notification-hook-registration-unverified',
    });
    assert.equal(
      state.current().plugins?.entries?.['agent-system']?.hooks?.allowConversationAccess,
      true,
    );
    assert.equal(state.inspections(), 1);
  });

  it('should preserve an independent prompt-injection denial', async () => {
    const state = fixture();
    state.current().plugins!.entries!['agent-system']!.hooks!.allowPromptInjection = false;
    const before = structuredClone(state.current());
    await assert.rejects(state.service.reconcile('/workspace'), {
      code: 'github-notification-prompt-injection-denied',
    });
    assert.deepEqual(state.current(), before);
    assert.equal(state.mutations(), 0);
  });

  it('should reject malformed or failed inspection without exposing command output', () => {
    for (const result of [
      { code: 1, stderr: 'private diagnostic', stdout: 'private output' },
      { code: 0, stderr: '', stdout: '{invalid' },
      {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ typedHooks: [{ name: 'before_prompt_build' }] }),
      },
      report(false),
    ]) {
      const finding = inspectConversationHookReport(result);
      assert.equal(finding.status, 'blocked');
      assert.doesNotMatch(finding.message, /private diagnostic|private output/u);
    }
    assert.equal(inspectConversationHookReport(report()).status, 'healthy');
  });

  it('should not treat another hook or updated config as proof that a blocked runtime reloaded', () => {
    const input = {
      config: config(true),
      registrationPolicy: inspectConversationHookPolicy(config()),
      hasRequiredHooks: true,
    };
    assert.equal(inspectRunningConversationHook(input).status, 'blocked');
    input.registrationPolicy = inspectConversationHookPolicy(config(true));
    input.hasRequiredHooks = false;
    assert.equal(inspectRunningConversationHook(input).status, 'blocked');
    input.hasRequiredHooks = true;
    assert.equal(inspectRunningConversationHook(input).status, 'healthy');
    input.config = config(false);
    assert.equal(
      inspectRunningConversationHook(input).code,
      'github-notification-hook-access-required',
    );
  });

  it('should never grant or revoke shared permission for disabled notifications', async () => {
    let touched = false;
    const contribution = createNotificationLifecycleContribution({
      hookAccess: {
        inspect: async () => {
          touched = true;
          throw new Error('unexpected');
        },
        reconcile: async () => {
          touched = true;
          throw new Error('unexpected');
        },
      },
      routingService: {
        inspect: async () => ({
          kind: 'noop',
          code: 'notification-routing-disabled',
          message: 'disabled',
        }),
        reconcile: async () => ({
          configChanged: false,
          requiresManualRestart: false,
          receiptAction: 'none',
          plan: { kind: 'noop', code: 'notification-routing-disabled', message: 'disabled' },
        }),
      },
    });
    const context = {
      manifest: { schemaVersion: 1 as const, agent: { id: 'data' } },
      workspaceDir: '/workspace',
    };
    await contribution.inspect!(context);
    await contribution.reconcile!(context);
    assert.equal(touched, false);
  });
});
