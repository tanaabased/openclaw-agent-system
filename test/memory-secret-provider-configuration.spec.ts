import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import {
  createMemorySecretProviderConfiguration,
  isAgentSystemMemorySecretProvider,
} from '../agent/memory-secret-provider-configuration.ts';

const temporaryRoots: string[] = [];

async function createLinkedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-system-memory-provider-'));
  temporaryRoots.push(root);
  const packageDir = join(root, 'package');
  const distDir = join(packageDir, 'dist');
  const nodeExecutable = join(root, 'node');
  await mkdir(distDir, { recursive: true });
  await writeFile(nodeExecutable, '#!/bin/sh\n');
  await chmod(nodeExecutable, 0o700);
  await writeFile(join(distDir, 'memory-secret-provider-entry.js'), 'export {};\n');
  return {
    nodeExecutable: await realpath(nodeExecutable),
    packageDir: await realpath(packageDir),
  };
}

describe('agent/memory-secret-provider-configuration', () => {
  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
  });

  it('should retain plugin integration for managed package installations', async () => {
    const fixture = await createLinkedFixture();

    const provider = createMemorySecretProviderConfiguration({
      config: {},
      ...fixture,
    });

    assert.deepEqual(provider, {
      source: 'exec',
      pluginIntegration: { pluginId: 'agent-system', integrationId: 'environment' },
    });
  });

  it('should configure canonical bounded execution for a linked checkout', async () => {
    const fixture = await createLinkedFixture();
    const alias = `${fixture.packageDir}-alias`;
    await symlink(fixture.packageDir, alias, 'dir');
    const config: OpenClawConfig = { plugins: { load: { paths: [alias] } } };

    const provider = createMemorySecretProviderConfiguration({ config, ...fixture });

    assert.deepEqual(provider, {
      source: 'exec',
      command: fixture.nodeExecutable,
      args: [join(fixture.packageDir, 'dist', 'memory-secret-provider-entry.js')],
      timeoutMs: 90_000,
      noOutputTimeoutMs: 90_000,
      maxOutputBytes: 1024 * 1024,
      jsonOnly: true,
      passEnv: [
        'DBUS_SESSION_BUS_ADDRESS',
        'HOME',
        'OPENAI_API_KEY',
        'OPENCLAW_CONFIG_PATH',
        'OPENCLAW_STATE_DIR',
        'XDG_CONFIG_HOME',
        'XDG_RUNTIME_DIR',
      ],
      trustedDirs: [dirname(fixture.nodeExecutable), fixture.packageDir],
    });
    assert.equal(isAgentSystemMemorySecretProvider(provider), true);
  });

  it('should reject missing or insecure linked entrypoints', async () => {
    const fixture = await createLinkedFixture();
    const config: OpenClawConfig = {
      plugins: { load: { paths: [fixture.packageDir] } },
    };
    const entrypoint = join(fixture.packageDir, 'dist', 'memory-secret-provider-entry.js');
    await rm(entrypoint);

    assert.throws(() => createMemorySecretProviderConfiguration({ config, ...fixture }));

    const outside = join(dirname(fixture.packageDir), 'outside.js');
    await writeFile(outside, '');
    await symlink(outside, entrypoint);
    assert.throws(() => createMemorySecretProviderConfiguration({ config, ...fixture }));

    await rm(entrypoint);
    await writeFile(entrypoint, '');
    await chmod(entrypoint, 0o666);
    assert.throws(() => createMemorySecretProviderConfiguration({ config, ...fixture }));
  });
});
