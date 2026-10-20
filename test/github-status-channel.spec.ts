import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { Value } from 'typebox/value';

import createGitHubChannelLifecycle from '../agent/github-channel-lifecycle.ts';
import createGitHubStatusChannel from '../channels/github/channel.ts';
import { githubChannelAccounts, githubChannelId } from '../channels/github/channel-config.ts';
import type { AgentManifest } from '../manifest/types.ts';
import pluginManifest from '../openclaw.plugin.json' with { type: 'json' };
import { baseline, intakeFixture } from './github-intake-fixture.ts';

function manifest(): AgentManifest {
  return {
    schemaVersion: 1,
    agent: { id: 'receiver' },
    github: {
      username: 'receiver',
      notifications: { ...intakeFixture().policy, runtimes: ['openclaw'] },
    },
  };
}

describe('github readiness channel', () => {
  it('should accept legacy accounts and limits without accepting unknown options', () => {
    const schema = pluginManifest.channelConfigs['agent-system-github'].schema;
    assert.equal(Value.Check(schema, { accounts: { receiver: { enabled: true } } }), true);
    assert.equal(
      Value.Check(schema, { accounts: { receiver: { enabled: true, arbitrary: true } } }),
      false,
    );
    const limits = pluginManifest.configSchema.properties.githubNotifications;
    assert.equal(Value.Check(limits, { maxCommentCharacters: 8000 }), true);
    assert.equal(Value.Check(limits, { maxCommentCharacters: 0 }), false);
  });

  it('should enable, preserve other accounts, repeat unchanged and disable only its own account', async () => {
    const workspaceDir = await realpath(process.cwd());
    const value = manifest();
    let config: OpenClawConfig = {
      channels: { [githubChannelId]: { accounts: { other: { enabled: true } } } },
    };
    let writes = 0;
    const lifecycle = createGitHubChannelLifecycle({
      readConfig: () => config,
      async mutateConfigFile({ mutate }) {
        writes++;
        const next = structuredClone(config);
        const result = mutate(next);
        config = next;
        return { result: Boolean(result) };
      },
    });
    const context = { manifest: value, workspaceDir };
    assert.equal((await lifecycle.inspect!(context))[0]?.status, 'drift');
    assert.equal(writes, 0);
    await lifecycle.reconcile!(context);
    assert.deepEqual(githubChannelAccounts(config), {
      receiver: { enabled: true, managedWorkspace: workspaceDir },
      other: { enabled: true },
    });
    assert.equal((await lifecycle.reconcile!(context)).outcomes[0]?.status, 'unchanged');
    assert.equal(writes, 1);
    value.github!.notifications!.issueAssignment!.paused = true;
    assert.equal((await lifecycle.reconcile!(context)).outcomes[0]?.status, 'unchanged');
    assert.equal(githubChannelAccounts(config).receiver?.enabled, true);
    assert.equal(writes, 1);
    delete value.github!.notifications;
    assert.equal((await lifecycle.inspect!(context))[0]?.status, 'drift');
    await lifecycle.reconcile!(context);
    assert.equal(githubChannelAccounts(config).receiver?.enabled, false);
    assert.equal(githubChannelAccounts(config).other?.enabled, true);
  });

  it('should refuse unowned and rebound accounts and recheck ownership inside mutation', async () => {
    const workspaceDir = await realpath(process.cwd());
    const value = manifest();
    for (const existing of [{ enabled: true }, { enabled: true, managedWorkspace: '/different' }]) {
      const config: OpenClawConfig = {
        channels: { [githubChannelId]: { accounts: { receiver: existing } } },
      };
      const lifecycle = createGitHubChannelLifecycle({
        readConfig: () => config,
        async mutateConfigFile() {
          throw Error('must not write');
        },
      });
      await assert.rejects(lifecycle.reconcile!({ manifest: value, workspaceDir }), {
        code: 'github-channel-conflict',
      });
    }
    const lifecycle = createGitHubChannelLifecycle({
      readConfig: () => ({}),
      async mutateConfigFile({ mutate }) {
        mutate({ channels: { [githubChannelId]: { accounts: { receiver: { enabled: true } } } } });
        return {};
      },
    });
    await assert.rejects(lifecycle.reconcile!({ manifest: value, workspaceDir }), {
      code: 'github-channel-conflict',
    });
  });

  it('should adopt exact legacy managed bindings without altering them or activating absent policy', async () => {
    const workspaceDir = await realpath(process.cwd());
    const value = manifest();
    const config: OpenClawConfig = {
      bindings: [
        {
          type: 'route',
          agentId: 'receiver',
          session: { dmScope: 'per-account-channel-peer' },
          comment: 'managed by agent system github notifications',
          match: { channel: githubChannelId, accountId: 'receiver' },
        },
      ],
      channels: { [githubChannelId]: { accounts: { receiver: { enabled: true } } } },
    };
    const originalBindings = structuredClone(config.bindings);
    const lifecycle = createGitHubChannelLifecycle({
      readConfig: () => config,
      async mutateConfigFile({ mutate }) {
        return { result: Boolean(mutate(config)) };
      },
    });
    delete value.github!.notifications;
    await lifecycle.reconcile!({ manifest: value, workspaceDir });
    assert.equal(githubChannelAccounts(config).receiver?.enabled, false);
    assert.deepEqual(config.bindings, originalBindings);
  });

  it('should report readiness, drift and failures without starting a transport or exposing errors', async () => {
    const value = manifest();
    let automation: string | undefined;
    let code: string | undefined;
    let checkpoint: number | null = baseline;
    let fail = false;
    const config: OpenClawConfig = {
      channels: {
        [githubChannelId]: {
          accounts: { receiver: { enabled: true, managedWorkspace: '/workspace' } },
        },
      },
    };
    const channel = createGitHubStatusChannel({
      manifestService: {
        async loadForAgentId() {
          if (fail) throw Error('secret provider details');
          return {
            status: 'loaded',
            manifest: value,
            scope: { workspaceDir: '/workspace', agentId: 'receiver' },
            path: '/workspace/agent.yaml',
            digest: 'fixture',
            diagnostics: [],
            validationChecks: [],
          };
        },
      },
      intake: {
        async inspect() {
          return {
            status: code ? 'blocked' : 'ready',
            code,
            checkpoint,
            baselineAt: baseline,
            records: [],
          };
        },
      },
      async automationReadiness() {
        return automation;
      },
      now: () => baseline + 1000,
    });
    const snapshot = () =>
      channel.status!.buildAccountSnapshot!({
        account: channel.config.resolveAccount(config, 'receiver'),
        cfg: config,
      });
    assert.equal(channel.gateway, undefined);
    assert.equal(channel.outbound, undefined);
    assert.equal((await snapshot()).statusState, 'healthy');
    checkpoint = null;
    assert.equal((await snapshot()).statusState, 'awaiting-first-scan');
    checkpoint = baseline - 20 * 60_000;
    assert.equal((await snapshot()).stateReason, 'intake-scan-overdue');
    code = 'intake-policy-reconciliation-required';
    assert.notEqual((await snapshot()).statusState, 'sync-required');
    code = 'intake-automation-update-required';
    assert.equal((await snapshot()).statusState, 'sync-required');
    code = 'intake-activation-required';
    assert.equal((await snapshot()).statusState, 'setup-required');
    code = undefined;
    automation = 'intake-automation-update-required';
    assert.equal((await snapshot()).statusState, 'sync-required');
    automation = 'intake-activation-required';
    assert.equal((await snapshot()).statusState, 'setup-required');
    for (const expected of [
      'automation-sync-required',
      'automation-execution-failed',
      'automation-delivery-failed',
      'automation-observation-unavailable',
    ]) {
      automation = expected;
      assert.equal((await snapshot()).stateReason, expected);
    }
    automation = undefined;
    checkpoint = baseline;
    value.github!.notifications!.issueAssignment!.feedback = true;
    value.github!.notifications!.reviewRequest = {
      enabled: true,
      allowed: [{ login: 'operator', nodeId: 'U_operator' }],
    };
    const degraded = await snapshot();
    assert.equal(degraded.statusState, 'degraded');
    assert.equal(degraded.lifecycle, 'ready');
    assert.equal(degraded.running, true);
    assert.doesNotMatch(degraded.lastError!, /feedback/);
    assert.match(degraded.lastError!, /review requests/);
    checkpoint = null;
    assert.equal((await snapshot()).stateReason, 'github-notification-capabilities-degraded');
    checkpoint = baseline - 20 * 60_000;
    assert.equal((await snapshot()).stateReason, 'intake-scan-overdue');
    code = undefined;
    checkpoint = baseline;
    value.github!.notifications!.issueAssignment!.mode = 'work';
    assert.equal((await snapshot()).statusState, 'degraded');
    fail = true;
    const failed = await snapshot();
    assert.equal(failed.statusState, 'unknown');
    assert.equal(JSON.stringify(failed).includes('secret'), false);
  });
});
