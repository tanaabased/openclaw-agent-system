import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// exercise the saved-state reader and lifecycle consumers with an older active snapshot.
describe('core/read-lifecycle-config installation handoff', () => {
  it('should see child registration and continue installation without publishing reads as runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-config-handoff-'));
    try {
      const source = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `
        import assert from 'node:assert/strict';
        import { writeFileSync } from 'node:fs';
        import { clearRuntimeConfigSnapshot, getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from 'openclaw/plugin-sdk/runtime-config-snapshot';
        import { mutateConfigFile } from 'openclaw/plugin-sdk/config-mutation';
        import readLifecycleConfig from ${source('../core/read-lifecycle-config.ts')};
        import createAgentLifecycle from ${source('../agent/identity/lifecycle.ts')};
        import createToolAccessLifecycle from ${source('../api/access-lifecycle.ts')};

        const saved = { meta: { migrations: { utilityModelSeparation: true } }, agents: { entries: {} } };
        const path = process.env.OPENCLAW_CONFIG_PATH;
        const context = { manifest: { schemaVersion: 1, agent: { id: 'data', name: 'Data' } }, workspaceDir: '/workspace/data' };
        const pinned = structuredClone(saved);
        writeFileSync(path, JSON.stringify(saved));
        setRuntimeConfigSnapshot(pinned);
        const registration = createAgentLifecycle({
          readConfig: readLifecycleConfig,
          async runOpenClawCommand(args) {
            if (args[1] === 'add') saved.agents.entries.data = { workspace: context.workspaceDir };
            else saved.agents.entries.data.identity = { name: 'Data' };
            writeFileSync(path, JSON.stringify(saved));
            return { code: 0, stderr: '', stdout: '{}' };
          },
        });
        assert.equal((await registration.reconcile(context)).outcomes[0].status, 'created');
        assert.equal((await readLifecycleConfig()).agents.entries.data.identity.name, 'Data');
        assert.equal(getRuntimeConfigSnapshot(), pinned, 'inspection must not replace active runtime state');
        const access = createToolAccessLifecycle({
          readConfig: readLifecycleConfig,
          mutateConfigFile,
          toolGrants: () => ({ desired: ['agent_system_git'], owned: ['agent_system_git'] }),
        });
        assert.equal((await access.reconcile(context)).outcomes[0].status, 'updated');
        assert.deepEqual((await readLifecycleConfig()).agents.entries.data.tools.alsoAllow, ['agent_system_git']);
        assert.equal((await access.reconcile(context)).outcomes[0].status, 'unchanged');

        clearRuntimeConfigSnapshot();
        assert.equal((await readLifecycleConfig()).agents.entries.data.workspace, context.workspaceDir);
        assert.equal(getRuntimeConfigSnapshot(), null, 'cold inspection must not prepare global runtime state');
        writeFileSync(path, '{ invalid json');
        await assert.rejects(() => readLifecycleConfig(), { code: 'openclaw-config-invalid' });
        const failure = new Error('source binding changed');
        await assert.rejects(() => readLifecycleConfig(async () => { throw failure; }), (error) => error === failure);
      `,
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            HOME: root,
            OPENCLAW_STATE_DIR: root,
            OPENCLAW_CONFIG_PATH: join(root, 'openclaw.json'),
          },
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
