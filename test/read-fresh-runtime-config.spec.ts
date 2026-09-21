import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import readFreshRuntimeConfig from '../core/read-fresh-runtime-config.ts';

describe('core/read-fresh-runtime-config', () => {
  it('should bypass the pinned runtime snapshot', () => {
    const expected: OpenClawConfig = {
      agents: { entries: { data: { workspace: '/workspace/data' } } },
    };
    let received: { pin?: boolean } | undefined;

    const actual = readFreshRuntimeConfig((options) => {
      received = options;
      return expected;
    });

    assert.deepEqual(received, { pin: false });
    assert.equal(actual, expected);
  });

  it('should accept current openclaw migration metadata through the real sdk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-config-'));
    const configPath = join(root, 'openclaw.json');
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousTempDir = process.env.TMPDIR;
    await writeFile(
      configPath,
      JSON.stringify({ meta: { migrations: { utilityModelSeparation: true } } }),
    );
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = join(root, 'state');
    process.env.TMPDIR = root;

    try {
      const actual = readFreshRuntimeConfig();

      assert.equal(actual.meta?.migrations?.utilityModelSeparation, true);
    } finally {
      if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      if (previousTempDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTempDir;
      await rm(root, { recursive: true });
    }
  });
});
