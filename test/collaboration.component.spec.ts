import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import planCollaboration, { collaborationConfiguration } from '../agent/collaboration-plan.ts';
import createCollaborationLifecycleContribution, {
  discoverCollaborationMembers,
} from '../agent/collaboration-lifecycle.ts';

function select(config: OpenClawConfig, selection: unknown) {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  const plugin = (config.plugins.entries['agent-system'] ??= {});
  plugin.config = { ...plugin.config, collaboration: selection };
  return config;
}

function restricted(): OpenClawConfig {
  return { tools: { agentToAgent: { enabled: false }, sessions: { visibility: 'agent' } } };
}

describe('managed collaboration', () => {
  it('should automatically reconcile disabled restricted hosts without a migration gate', () => {
    const input = restricted();
    input.tools!.agentToAgent!.allow = ['external'];
    const original = structuredClone(input);
    const installed = planCollaboration(input, ['beta', 'alpha']);
    assert.deepEqual(input, original);
    assert.deepEqual(installed.config.tools?.agentToAgent, {
      enabled: true,
      allow: ['external', 'alpha', 'beta'],
    });
    assert.equal(installed.config.tools?.sessions?.visibility, 'all');
    assert.deepEqual(installed.ownedAgentIds, ['alpha', 'beta']);
    assert.deepEqual(installed.connectedExternalEntries, ['external']);
    assert.equal(planCollaboration(installed.config, ['alpha', 'beta']).changed, false);
    assert.deepEqual(
      planCollaboration(installed.config, ['alpha', 'beta']).connectedExternalEntries,
      [],
    );
  });

  it('should preserve sufficient native policies without normalization or ownership', () => {
    for (const allow of [undefined, [], ['*'], ['alpha', 'beta', 'external'], ['AL*', 'b*']]) {
      for (const enabled of [undefined, true]) {
        const config: OpenClawConfig = { tools: { agentToAgent: { enabled, allow } } };
        const result = planCollaboration(config, ['alpha', 'beta']);
        assert.deepEqual(result.config, config);
        assert.equal(result.changed, false);
        assert.deepEqual(result.ownedAgentIds, []);
      }
    }
    assert.equal(planCollaboration({}, ['alpha', 'beta']).changed, false);
  });

  it('should preserve a later operator unrestricted policy when no grants need withdrawal', () => {
    const installed = planCollaboration(restricted(), ['alpha', 'beta']).config;
    delete installed.tools!.agentToAgent!.allow;
    const result = planCollaboration(installed, ['alpha', 'beta']);
    assert.deepEqual(result.config.tools, installed.tools);
    assert.deepEqual(result.ownedAgentIds, []);
    assert.equal(planCollaboration(result.config, ['alpha', 'beta']).changed, false);
  });

  it('should respect matching native wildcards without stealing ownership', () => {
    const config: OpenClawConfig = {
      tools: {
        agentToAgent: {
          enabled: false,
          allow: ['external', 'AL*', 'b*t*', ' literal '],
        },
      },
    };
    const installed = planCollaboration(config, ['alpha', 'beta', 'gamma']);
    assert.deepEqual(installed.ownedAgentIds, ['gamma']);
    const disabled = planCollaboration(select(installed.config, false), []);
    assert.deepEqual(disabled.config.tools?.agentToAgent?.allow, config.tools?.agentToAgent?.allow);
    assert.equal(disabled.config.tools?.agentToAgent?.enabled, true);
  });

  it('should establish exact grants atomically when enabling an empty disabled host', () => {
    for (const allow of [undefined, []]) {
      const input = restricted();
      input.tools!.agentToAgent!.allow = allow;
      const result = planCollaboration(input, ['alpha', 'beta']);
      assert.deepEqual(result.config.tools?.agentToAgent, {
        enabled: true,
        allow: ['alpha', 'beta'],
      });
      assert.equal(result.config.tools?.sessions?.visibility, 'all');
    }
  });

  it('should change only visibility when existing enabled permissions are sufficient', () => {
    for (const allow of [undefined, ['*'], ['alpha', 'beta']]) {
      const config: OpenClawConfig = {
        tools: { agentToAgent: { enabled: true, allow }, sessions: { visibility: 'self' } },
      };
      const result = planCollaboration(config, ['alpha', 'beta']);
      assert.deepEqual(result.config.tools?.agentToAgent, config.tools?.agentToAgent);
      assert.deepEqual(result.ownedAgentIds, []);
      assert.equal(result.config.tools?.sessions?.visibility, 'all');
    }
  });

  it('should leave fresh auto zero and singleton teams quiet and untouched', () => {
    for (const members of [[], ['alpha']]) {
      const input = restricted();
      const result = planCollaboration(input, members);
      assert.equal(result.notApplicable, true);
      assert.deepEqual(result.config, input);
    }
    assert.equal(collaborationConfiguration({}).selection, 'auto');
  });

  it('should retain surviving owned grants and disable an emptied team without changing visibility', () => {
    const installed = planCollaboration(restricted(), ['alpha', 'beta']).config;
    installed.tools!.sessions!.visibility = 'self';
    const shrunk = planCollaboration(installed, ['beta']);
    assert.deepEqual(shrunk.ownedAgentIds, ['beta']);
    assert.deepEqual(shrunk.config.tools?.agentToAgent?.allow, ['beta']);
    const removed = planCollaboration(shrunk.config, []);
    assert.deepEqual(removed.config.tools?.agentToAgent, { enabled: false, allow: [] });
    assert.equal(removed.config.tools?.sessions?.visibility, 'all');
    assert.equal(planCollaboration(removed.config, []).changed, false);
    const rejoined = planCollaboration(removed.config, ['alpha', 'beta']);
    assert.deepEqual(rejoined.config.tools?.agentToAgent, {
      enabled: true,
      allow: ['alpha', 'beta'],
    });
  });

  it('should prevent unrestricted access when native deletion already pruned owned ids', () => {
    for (const allow of [undefined, []]) {
      const installed = planCollaboration(restricted(), ['alpha', 'beta']).config;
      installed.tools!.agentToAgent!.allow = allow;
      const removed = planCollaboration(installed, []);
      assert.deepEqual(removed.config.tools?.agentToAgent, { allow: [], enabled: false });
      assert.deepEqual(removed.ownedAgentIds, []);
      assert.equal(planCollaboration(removed.config, []).changed, false);
      const remaining = planCollaboration(installed, ['beta']);
      assert.deepEqual(remaining.config.tools?.agentToAgent, { allow: ['beta'], enabled: true });
    }
  });

  it('should select exact registered participants and withdraw only owned grants', () => {
    const input = select({ tools: { agentToAgent: { allow: ['external'] } } }, ['alpha']);
    const installed = planCollaboration(input, ['alpha', 'external', 'beta']);
    assert.deepEqual(installed.members, ['alpha']);
    assert.deepEqual(installed.config.tools?.agentToAgent?.allow, ['external', 'alpha']);
    const changed = planCollaboration(select(installed.config, ['beta']), ['alpha', 'beta']);
    assert.deepEqual(changed.config.tools?.agentToAgent?.allow, ['external', 'beta']);
    changed.config.tools!.sessions = { visibility: 'self' };
    const disabled = planCollaboration(select(changed.config, false), []);
    assert.deepEqual(disabled.config.tools?.agentToAgent?.allow, ['external']);
    assert.equal(disabled.config.tools?.agentToAgent?.enabled, true);
    assert.equal(disabled.config.tools?.sessions?.visibility, 'self');
    assert.equal(planCollaboration(disabled.config, []).changed, false);
  });

  it('should give all future coverage and replace only an owned wildcard on return to auto', () => {
    const input = select({ tools: { agentToAgent: { allow: ['external', 'alpha'] } } }, 'all');
    const all = planCollaboration(input, ['alpha', 'beta', 'external']);
    assert.deepEqual(all.ownedAgentIds, ['*']);
    assert.deepEqual(all.config.tools?.agentToAgent?.allow, ['external', 'alpha', '*']);
    assert.equal(
      planCollaboration(all.config, ['alpha', 'beta', 'external', 'future']).changed,
      false,
    );
    const auto = planCollaboration(select(all.config, 'auto'), ['alpha', 'beta']);
    assert.deepEqual(auto.config.tools?.agentToAgent?.allow, ['external', 'alpha', 'beta']);
    assert.deepEqual(auto.ownedAgentIds, ['beta']);
    const disabled = planCollaboration(select(all.config, false), []);
    assert.deepEqual(disabled.config.tools?.agentToAgent?.allow, ['external', 'alpha']);
    for (const allow of [undefined, [], ['*'], [' ** ']]) {
      const unrestricted = select({ tools: { agentToAgent: { enabled: true, allow } } }, 'all');
      const result = planCollaboration(unrestricted, ['alpha', 'external']);
      assert.equal(result.changed, false);
      assert.deepEqual(result.ownedAgentIds, []);
    }
    const empty = planCollaboration(select(restricted(), 'all'), []);
    assert.deepEqual(empty.config.tools?.agentToAgent, { enabled: true, allow: ['*'] });
  });

  it('should disable safely when withdrawing an owned wildcard with no operator entries', () => {
    const all = planCollaboration(select(restricted(), 'all'), ['alpha']).config;
    const auto = planCollaboration(select(structuredClone(all), 'auto'), []);
    assert.deepEqual(auto.config.tools?.agentToAgent, { enabled: false, allow: [] });
    const disabled = planCollaboration(select(all, false), []);
    assert.deepEqual(disabled.config.tools?.agentToAgent, { enabled: false, allow: [] });
  });

  it('should report unregistered selections and reject invalid selection or ownership', () => {
    const installed = planCollaboration(select(restricted(), ['alpha']), ['alpha']).config;
    const removed = planCollaboration(installed, []);
    assert.deepEqual(removed.unavailableMembers, ['alpha']);
    assert.deepEqual(removed.config.tools?.agentToAgent, { allow: [], enabled: false });
    assert.equal(
      planCollaboration(select(installed, []), ['alpha']).config.tools?.agentToAgent?.enabled,
      false,
    );
    for (const selection of [true, null, ['*'], ['Alpha'], ['alpha', 'alpha']])
      assert.throws(() => planCollaboration(select({}, selection), ['alpha']));
    const broken = select({}, 'all');
    broken.plugins!.entries!['agent-system']!.config!.collaborationState = {};
    assert.throws(() => planCollaboration(broken, ['alpha']), /ownership state/u);
  });
});

describe('collaboration lifecycle', () => {
  let root: string;
  let config: OpenClawConfig;
  let writes: number;
  let rejectWrite: boolean;
  let beforeWrite: (() => void) | undefined;
  const resolveAgentWorkspaceDir = (_: OpenClawConfig, id: string) => join(root, id);
  function lifecycle() {
    return createCollaborationLifecycleContribution({
      readConfig: () => structuredClone(config),
      resolveAgentWorkspaceDir,
      async mutateConfigFile({ mutate }) {
        beforeWrite?.();
        const draft = structuredClone(config);
        await mutate(draft);
        if (rejectWrite) throw new Error('write failed');
        if (JSON.stringify(draft) !== JSON.stringify(config)) writes++;
        config = draft;
      },
    });
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'collaboration-'));
    writes = 0;
    rejectWrite = false;
    beforeWrite = undefined;
    config = {
      ...restricted(),
      agents: {
        entries: {
          alpha: { workspace: join(root, 'alpha') },
          beta: { workspace: join(root, 'beta') },
        },
      },
    };
    for (const id of ['alpha', 'beta']) {
      await mkdir(join(root, id));
      await writeFile(
        join(root, id, 'agent.yaml'),
        `schema-version: 1\nagent:\n  id: ${id}\n  name: ${id}\n`,
      );
    }
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should inspect without writes and reconcile fresh membership with verified ownership', async () => {
    assert.equal((await lifecycle().inspect())[0]?.status, 'drift');
    assert.equal(writes, 0);
    await lifecycle().reconcile();
    await lifecycle().reconcile();
    assert.equal(writes, 1);
    assert.equal((await lifecycle().inspect())[0]?.status, 'healthy');
    assert.deepEqual(collaborationConfiguration(config).state?.ownedAgentIds, ['alpha', 'beta']);
    delete config.agents!.entries!.alpha;
    await lifecycle().reconcile();
    assert.deepEqual(config.tools?.agentToAgent?.allow, ['beta']);
    delete config.agents!.entries!.beta;
    await lifecycle().reconcile();
    assert.deepEqual(config.tools?.agentToAgent, { enabled: false, allow: [] });
  });

  it('should use canonical keyed registrations and preserve unmanaged participants', async () => {
    config.agents!.list = [{ id: 'unregistered', workspace: '/unused' }];
    await mkdir(join(root, 'external'));
    config.agents!.entries!.external = { workspace: join(root, 'external') };
    config.tools = { agentToAgent: { allow: ['external', 'alpha'] } };
    await lifecycle().reconcile();
    assert.deepEqual(collaborationConfiguration(config).state?.ownedAgentIds, ['beta']);
    assert.deepEqual(config.tools?.agentToAgent?.allow, ['external', 'alpha', 'beta']);
  });

  it('should block uncertain membership and preserve grants after a manifest disappears', async () => {
    await lifecycle().reconcile();
    await rm(join(root, 'alpha', 'agent.yaml'));
    const before = structuredClone(config);
    assert.equal((await lifecycle().inspect())[0]?.code, 'collaboration-discovery-blocked');
    await assert.rejects(lifecycle().reconcile(), /membership/u);
    assert.deepEqual(config, before);
  });

  it('should reject identity mismatches and unreadable registered workspaces', async () => {
    await writeFile(join(root, 'alpha', 'agent.yaml'), 'schema-version: 1\nagent:\n  id: other\n');
    await assert.rejects(
      discoverCollaborationMembers(config, { resolveAgentWorkspaceDir }),
      /membership/u,
    );
    await rm(join(root, 'alpha'), { recursive: true });
    await assert.rejects(lifecycle().reconcile(), /membership/u);
    assert.equal(writes, 0);
  });

  it('should re-evaluate operator changes inside the config mutation and keep failed writes atomic', async () => {
    beforeWrite = () => {
      config.tools = { agentToAgent: { allow: ['external'] } };
    };
    await lifecycle().reconcile();
    assert.deepEqual(config.tools?.agentToAgent?.allow, ['external', 'alpha', 'beta']);
    beforeWrite = undefined;
    delete config.agents!.entries!.alpha;
    const before = structuredClone(config);
    rejectWrite = true;
    await assert.rejects(lifecycle().reconcile(), /write failed/u);
    assert.deepEqual(config, before);
  });

  it('should select unmanaged registered ids without requiring managed manifests', async () => {
    config.agents!.entries!.external = { workspace: '/not-needed' };
    select(config, ['alpha', 'external', 'missing']);
    assert.deepEqual(await discoverCollaborationMembers(config, { resolveAgentWorkspaceDir }), [
      'alpha',
      'external',
    ]);
    const result = await lifecycle().reconcile();
    assert.equal(result.warnings[0]?.code, 'collaboration-unavailable-members');
    assert.deepEqual(config.tools?.agentToAgent?.allow, ['alpha', 'external']);
    select(config, 'all');
    assert.deepEqual(await discoverCollaborationMembers(config, { resolveAgentWorkspaceDir }), [
      'alpha',
      'beta',
      'external',
    ]);
    await lifecycle().reconcile();
    assert.deepEqual(config.tools?.agentToAgent?.allow, ['*']);
  });

  it('should emit a single access notice only when connecting retained external entries', async () => {
    config.tools!.agentToAgent!.allow = ['external', 'support-*'];
    const installed = await lifecycle().reconcile();
    assert.equal(installed.warnings.length, 1);
    assert.equal(installed.warnings[0]?.code, 'collaboration-session-access');
    assert.match(installed.warnings[0]!.message, /external, support-\*/u);
    assert.match(installed.warnings[0]!.message, /reading and messaging/u);
    assert.deepEqual((await lifecycle().reconcile()).warnings, []);
  });

  it('should report a quiet singleton and keep inspection read-only', async () => {
    delete config.agents!.entries!.beta;
    assert.equal((await lifecycle().inspect())[0]?.code, 'collaboration-not-applicable');
    const result = await lifecycle().reconcile();
    assert.equal(result.outcomes[0]?.code, 'collaboration-not-applicable');
    assert.deepEqual(result.warnings, []);
    assert.equal(writes, 0);
  });
});
