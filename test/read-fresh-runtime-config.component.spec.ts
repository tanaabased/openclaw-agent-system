import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('core/read-fresh-runtime-config disk refresh', () => {
  it('should read a child config write instead of a stale prepared snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-fresh-config-'));
    try {
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
        import { setRuntimeConfigSnapshot } from 'openclaw/plugin-sdk/runtime-config-snapshot';
        import readFreshRuntimeConfig from ${JSON.stringify(new URL('../core/read-fresh-runtime-config.ts', import.meta.url).href)};
        const config = (workspace) => ({
          meta: { migrations: { utilityModelSeparation: true } },
          agents: { entries: { example: { workspace } } },
        });
        setRuntimeConfigSnapshot(config('/stale-workspace'));
        writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config('/fresh-workspace')));
        assert.equal(readFreshRuntimeConfig().agents.entries.example.workspace, '/fresh-workspace');
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
