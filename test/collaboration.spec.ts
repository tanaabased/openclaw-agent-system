import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import planCollaboration, { collaborationConfiguration } from '../agent/collaboration-plan.ts';
import createCollaborationLifecycleContribution, {
  discoverCollaborationMembers,
} from '../agent/collaboration-lifecycle.ts';
import collaborationCommand from '../cli/collaboration.ts';

function select(config: OpenClawConfig, selection: unknown) {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  const plugin = (config.plugins.entries['agent-system'] ??= {});
  plugin.config = { ...plugin.config, collaboration: selection };
  return config;
}

describe('managed collaboration', () => {
  it('should default to exact managed ids and converge without mutating the input', () => {
    const input: OpenClawConfig = { tools: { sessions: { visibility: 'all' } } };
    const original = structuredClone(input);
    const installed = planCollaboration(input, ['beta', 'alpha']);
    assert.deepEqual(input, original);
    assert.deepEqual(installed.config.tools?.agentToAgent, {
      enabled: true,
      allow: ['alpha', 'beta'],
    });
    assert.deepEqual(installed.ownedAgentIds, ['alpha', 'beta']);
    assert.equal(planCollaboration(installed.config, ['beta', 'alpha']).changed, false);
  });

  it('should preserve operator entries and never adopt a matching managed id', () => {
    const input: OpenClawConfig = {
      tools: { agentToAgent: { allow: ['external', '*', 'alpha'] } },
    };
    const installed = planCollaboration(input, ['alpha', 'beta']);
    assert.deepEqual(installed.ownedAgentIds, ['beta']);
    const removed = planCollaboration(installed.config, []);
    assert.deepEqual(removed.config.tools?.agentToAgent?.allow, ['external', '*', 'alpha']);
    assert.equal(removed.config.tools?.agentToAgent?.enabled, true);
    assert.deepEqual(removed.ownedAgentIds, []);
  });

  it('should disable access atomically when the final owned member is removed and rejoin safely', () => {
    const installed = planCollaboration({}, ['alpha']).config;
    const removed = planCollaboration(installed, []);
    assert.deepEqual(removed.config.tools?.agentToAgent, { allow: [], enabled: false });
    assert.equal(planCollaboration(removed.config, []).changed, false);
    const rejoined = planCollaboration(removed.config, ['beta']);
    assert.deepEqual(rejoined.config.tools?.agentToAgent, { allow: ['beta'], enabled: true });
  });

  it('should require explicit configuration to migrate initial restrictive host settings', () => {
    for (const tools of [
      { sessions: { visibility: 'agent' as const } },
      { agentToAgent: { enabled: false } },
    ]) {
      const config: OpenClawConfig = { tools };
      assert.throws(() => planCollaboration(config, ['alpha']), /host restrictions/u);
      const installed = planCollaboration(select(config, 'all'), ['alpha']);
      assert.equal(installed.config.tools?.sessions?.visibility, 'all');
      assert.equal(installed.config.tools?.agentToAgent?.enabled, true);
    }
  });

  it('should distinguish an explicit default from an earlier implicit default', () => {
    const empty = planCollaboration({ tools: { agentToAgent: { enabled: false } } }, []).config;
    assert.throws(() => planCollaboration(empty, ['alpha']), /host restrictions/u);
    assert.equal(
      planCollaboration(select(empty, 'all'), ['alpha']).config.tools?.agentToAgent?.enabled,
      true,
    );
  });

  it('should preserve later operator restrictions until the configuration selection changes', () => {
    const installed = planCollaboration(select({}, 'all'), ['alpha']).config;
    installed.tools!.sessions!.visibility = 'self';
    assert.throws(() => planCollaboration(installed, ['alpha']), /host restrictions/u);
    const disabled = planCollaboration(select(installed, false), ['alpha']).config;
    assert.equal(disabled.tools?.sessions?.visibility, 'self');
    assert.equal(
      planCollaboration(select(disabled, 'all'), ['alpha']).config.tools?.sessions?.visibility,
      'all',
    );
  });

  it('should not adopt an operator disable while cleaning up the final member', () => {
    const installed = planCollaboration({}, ['alpha']).config;
    installed.tools!.agentToAgent!.enabled = false;
    const removed = planCollaboration(installed, []).config;
    assert.equal(collaborationConfiguration(removed).state?.disabledEmpty, false);
    assert.throws(() => planCollaboration(removed, ['beta']), /host restrictions/u);
  });

  it('should leave an empty host untouched and defer initial migration until members exist', () => {
    assert.equal(planCollaboration({}, []).changed, false);
    const selected = select({ tools: { agentToAgent: { enabled: false } } }, 'all');
    assert.equal(planCollaboration(selected, []).changed, false);
    assert.equal(planCollaboration(selected, ['alpha']).config.tools?.agentToAgent?.enabled, true);
  });

  it('should select one group and withdraw only owned grants when disabled', () => {
    const installed = planCollaboration(
      select({ tools: { agentToAgent: { allow: ['external'] } } }, ['alpha']),
      ['alpha', 'beta'],
    );
    assert.deepEqual(installed.config.tools?.agentToAgent?.allow, ['external', 'alpha']);
    const disabled = planCollaboration(select(installed.config, false), ['alpha', 'beta']);
    assert.deepEqual(disabled.config.tools?.agentToAgent?.allow, ['external']);
    assert.equal(disabled.config.tools?.agentToAgent?.enabled, true);
    assert.equal(planCollaboration(disabled.config, []).changed, false);
  });

  it('should remove deleted explicit members while reporting unresolved selections', () => {
    const installed = planCollaboration(select({}, ['alpha']), ['alpha']).config;
    const removed = planCollaboration(installed, []);
    assert.deepEqual(removed.unavailableMembers, ['alpha']);
    assert.deepEqual(removed.config.tools?.agentToAgent, { allow: [], enabled: false });
    assert.equal(planCollaboration(removed.config, []).changed, false);
  });

  it('should treat an empty selection as no managed grants and reject invalid ids', () => {
    const installed = planCollaboration({}, ['alpha']).config;
    assert.equal(
      planCollaboration(select(installed, []), ['alpha']).config.tools?.agentToAgent?.enabled,
      false,
    );
    for (const selection of [true, null, ['*'], ['Alpha'], ['alpha', 'alpha']]) {
      assert.throws(() => planCollaboration(select({}, selection), ['alpha']));
    }
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
    assert.equal((await lifecycle().inspectHost())[0]?.status, 'drift');
    assert.equal(writes, 0);
    await lifecycle().reconcileHost();
    await lifecycle().reconcileHost();
    assert.equal(writes, 1);
    assert.equal((await lifecycle().inspectHost())[0]?.status, 'healthy');
    assert.deepEqual(collaborationConfiguration(config).state?.ownedAgentIds, ['alpha', 'beta']);
    delete config.agents!.entries!.alpha;
    await lifecycle().reconcileHost();
    assert.deepEqual(config.tools?.agentToAgent?.allow, ['beta']);
    delete config.agents!.entries!.beta;
    await lifecycle().reconcileHost();
    assert.deepEqual(config.tools?.agentToAgent, { enabled: false, allow: [] });
  });

  it('should use canonical keyed registrations and preserve unmanaged participants', async () => {
    config.agents!.list = [{ id: 'unregistered', workspace: '/unused' }];
    await mkdir(join(root, 'external'));
    config.agents!.entries!.external = { workspace: join(root, 'external') };
    config.tools = { agentToAgent: { allow: ['external', 'alpha'] } };
    await lifecycle().reconcileHost();
    assert.deepEqual(collaborationConfiguration(config).state?.ownedAgentIds, ['beta']);
    assert.deepEqual(config.tools?.agentToAgent?.allow, ['external', 'alpha', 'beta']);
  });

  it('should block uncertain membership and preserve grants after a manifest disappears', async () => {
    await lifecycle().reconcileHost();
    await rm(join(root, 'alpha', 'agent.yaml'));
    const before = structuredClone(config);
    assert.equal((await lifecycle().inspectHost())[0]?.code, 'collaboration-discovery-blocked');
    await assert.rejects(lifecycle().reconcileHost(), /membership/u);
    assert.deepEqual(config, before);
  });

  it('should reject identity mismatches and unreadable registered workspaces', async () => {
    await writeFile(join(root, 'alpha', 'agent.yaml'), 'schema-version: 1\nagent:\n  id: other\n');
    await assert.rejects(
      discoverCollaborationMembers(config, { resolveAgentWorkspaceDir }),
      /membership/u,
    );
    await rm(join(root, 'alpha'), { recursive: true });
    await assert.rejects(lifecycle().reconcileHost(), /membership/u);
    assert.equal(writes, 0);
  });

  it('should re-evaluate operator changes inside the config mutation and keep failed writes atomic', async () => {
    beforeWrite = () => {
      config.tools = { agentToAgent: { allow: ['external'] } };
    };
    await lifecycle().reconcileHost();
    assert.deepEqual(config.tools?.agentToAgent?.allow, ['external', 'alpha', 'beta']);
    beforeWrite = undefined;
    delete config.agents!.entries!.alpha;
    const before = structuredClone(config);
    rejectWrite = true;
    await assert.rejects(lifecycle().reconcileHost(), /write failed/u);
    assert.deepEqual(config, before);
  });

  it('should expose host-only json inspection and cleanup without a workspace', async () => {
    await lifecycle().reconcileHost();
    config.agents = {};
    const stdout: string[] = [];
    const stderr: string[] = [];
    const codes: number[] = [];
    const options = {
      lifecycle: lifecycle(),
      json: true,
      output: {
        writeStdout: (value: string) => stdout.push(value),
        writeStderr: (value: string) => stderr.push(value),
      },
      setExitCode: (code: number) => codes.push(code),
    };
    await collaborationCommand({ ...options, operation: 'inspect' });
    assert.deepEqual(codes, [1]);
    assert.equal(JSON.parse(stdout[0]!).findings[0].status, 'drift');
    await collaborationCommand({ ...options, operation: 'install' });
    assert.equal(config.tools?.agentToAgent?.enabled, false);
    assert.deepEqual(stderr, []);
  });
});
