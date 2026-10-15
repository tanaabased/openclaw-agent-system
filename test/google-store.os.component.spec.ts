import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GoogleClient from '../tools/google/client.ts';
import GoogleStore from '../tools/google/store.ts';
import { fakeGoogle, googleConfiguration, googleValues, material } from './google-test-fixture.ts';
import type { AgentSystemCliRunRequest } from '../api/types.ts';

function store(
  root: string,
  requests: AgentSystemCliRunRequest[] = [],
  options: Parameters<typeof fakeGoogle>[1] = {},
) {
  return new GoogleStore(
    root,
    new GoogleClient(fakeGoogle(requests, options), {
      PATH: '/usr/bin',
      GOG_ACCESS_TOKEN: 'host-token',
      GOG_HOME: '/host',
      GOOGLE_APPLICATION_CREDENTIALS: '/host/adc',
    }),
  );
}
describe('google store', () => {
  let root = '';
  let workspace = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'google-store-'));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('should reconcile unchanged credentials without reimporting and isolate child mutations', async () => {
    const requests: AgentSystemCliRunRequest[] = [];
    const owned = store(root, requests);
    assert.equal(
      await owned.reconcile('one', googleConfiguration.account, material(), workspace),
      'created',
    );
    const receipt = await readFile(join(root, 'one', 'tools', 'gog', 'current.json'), 'utf8');
    requests.length = 0;
    assert.equal(
      await owned.reconcile('one', googleConfiguration.account, material(), workspace),
      'unchanged',
    );
    assert.ok(
      !requests.some(
        (request) => request.argv.includes('import') || request.argv.includes('credentials'),
      ),
    );
    const lease = await owned.acquire('one', googleConfiguration.account, material());
    const home = lease.environment.HOME!;
    await writeFile(join(lease.environment.GOG_CONFIG_DIR!, 'config.json'), 'mutated');
    await lease.dispose();
    await assert.rejects(readFile(join(home, 'config', 'config.json')));
    assert.equal(await owned.inspect('one', googleConfiguration.account, material()), 'ready');
    assert.equal(
      await readFile(join(root, 'one', 'tools', 'gog', 'current.json'), 'utf8'),
      receipt,
    );
    for (const request of requests) {
      assert.equal(request.environment.GOG_ACCESS_TOKEN, undefined);
      assert.equal(request.environment.GOOGLE_APPLICATION_CREDENTIALS, undefined);
      assert.equal(request.environment.GOG_KEYRING_BACKEND, 'file');
      assert.ok(!request.argv.join(' ').includes('refresh-secret'));
    }
  });
  it('should keep two agent accounts and keyrings separate and reconcile password changes', async () => {
    const owned = store(root);
    const two = { ...googleConfiguration, account: 'two@example.com' };
    const twoMaterial = material(two, {
      ...googleValues,
      TOKEN: JSON.stringify({ email: two.account, refresh_token: 'two-refresh' }),
      PASSWORD: 'two-password',
    });
    await owned.reconcile('one', googleConfiguration.account, material(), workspace);
    await owned.reconcile('two', two.account, twoMaterial, workspace);
    const first = await owned.acquire('one', googleConfiguration.account, material());
    const second = await owned.acquire('two', two.account, twoMaterial);
    try {
      assert.notEqual(first.environment.GOG_DATA_DIR, second.environment.GOG_DATA_DIR);
      assert.equal(first.environment.GOG_KEYRING_PASSWORD, 'keyring-secret');
      assert.equal(second.environment.GOG_KEYRING_PASSWORD, 'two-password');
    } finally {
      await first.dispose();
      await second.dispose();
    }
    const changed = material(googleConfiguration, { ...googleValues, PASSWORD: 'new-password' });
    assert.equal(
      await owned.reconcile('one', googleConfiguration.account, changed, workspace),
      'updated',
    );
    assert.equal(await owned.inspect('one', googleConfiguration.account, material()), 'drift');
  });
  it('should preserve the active generation after identity or import failure and reject unsafe state', async () => {
    const owned = store(root);
    await owned.reconcile('one', googleConfiguration.account, material(), workspace);
    const file = join(root, 'one', 'tools', 'gog', 'current.json');
    const before = await readFile(file, 'utf8');
    const changed = material(googleConfiguration, { ...googleValues, PASSWORD: 'new-password' });
    await assert.rejects(
      store(root, [], { account: 'other@example.com' }).reconcile(
        'one',
        googleConfiguration.account,
        changed,
        workspace,
      ),
      { code: 'tool_identity_mismatch' },
    );
    assert.equal(await readFile(file, 'utf8'), before);
    const generation = JSON.parse(before).generation;
    await symlink(
      '/etc/passwd',
      join(root, 'one', 'tools', 'gog', generation, 'data', 'unexpected'),
    );
    await assert.rejects(owned.acquire('one', googleConfiguration.account, material()));
    assert.equal(
      (await readdir(join(root, 'one', 'tools', 'gog'))).filter((name) => name !== 'current.json')
        .length,
      1,
    );
  });
  it('should honor a declared home and host precedence while refusing cross-agent reuse', async () => {
    const owned = store(root);
    const home = join(root, 'declared-home');
    await owned.reconcile('one', googleConfiguration.account, material(), workspace, [], home);
    assert.equal(JSON.parse(await readFile(join(home, 'current.json'), 'utf8')).agentId, 'one');
    const lease = await owned.acquire(
      'one',
      googleConfiguration.account,
      material(),
      workspace,
      [],
      undefined,
      home,
    );
    try {
      assert.equal(lease.environment.GOG_HOME, lease.environment.HOME);
    } finally {
      await lease.dispose();
    }
    await assert.rejects(
      owned.reconcile('two', googleConfiguration.account, material(), workspace, [], home),
      { code: 'tool_identity_mismatch' },
    );
    const hostHome = join(root, 'host-home');
    const host = new GoogleStore(
      undefined,
      new GoogleClient(fakeGoogle(), { PATH: '/usr/bin' }),
      undefined,
      hostHome,
    );
    await host.reconcile('one', googleConfiguration.account, material(), workspace, [], home);
    assert.equal(
      await host.inspect('one', googleConfiguration.account, material(), 'relative-ignored'),
      'ready',
    );
    assert.ok(await readFile(join(hostHome, 'current.json')));
    await assert.rejects(
      owned.reconcile('one', googleConfiguration.account, material(), workspace, [], 'relative'),
      { code: 'configuration_unavailable' },
    );
    await assert.rejects(
      owned.reconcile(
        'one',
        googleConfiguration.account,
        material(),
        workspace,
        [],
        join(workspace, 'private'),
      ),
      { code: 'configuration_unavailable' },
    );
    await assert.rejects(
      owned.reconcile('one', googleConfiguration.account, material(), workspace, [], '/'),
      { code: 'configuration_unavailable' },
    );
  });
  it('should reject a home hidden inside a workspace through a symlink', async () => {
    const alias = join(root, 'workspace-alias');
    await symlink(workspace, alias);
    await assert.rejects(
      store(root).reconcile(
        'one',
        googleConfiguration.account,
        material(),
        workspace,
        [],
        join(alias, 'gog'),
      ),
      { code: 'configuration_unavailable' },
    );
  });
  it('should serialize installation and leave the winning credentials usable', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = fakeGoogle();
    let first = true;
    const owned = new GoogleStore(
      root,
      new GoogleClient(
        async (request) => {
          if (first) {
            first = false;
            enter();
            await resume;
          }
          return runner(request);
        },
        { PATH: '/usr/bin' },
      ),
    );
    const installing = owned.reconcile('one', googleConfiguration.account, material(), workspace);
    await entered;
    try {
      await assert.rejects(
        owned.reconcile('one', googleConfiguration.account, material(), workspace),
        /installation is busy/u,
      );
    } finally {
      release();
    }
    assert.equal(await installing, 'created');
    assert.equal(await owned.inspect('one', googleConfiguration.account, material()), 'ready');
    assert.equal(
      await owned.reconcile('one', googleConfiguration.account, material(), workspace),
      'unchanged',
    );
  });
  it('should accept reviewed versions and subsequent stable minor and patch releases', async () => {
    for (const version of [
      'v0.42.0',
      'v0.43.0 (test)',
      'gog v0.43.1',
      'gogcli 0.44.0',
      'v0.100.0+build.1',
    ])
      await new GoogleClient(fakeGoogle([], { version }), {}).checkVersion(
        {},
        workspace,
        googleConfiguration.account,
      );
  });
  it('should reject older, prerelease, major and unrecognized versions', async () => {
    for (const version of ['v0.41.99', 'v0.43.0-dev', 'v0.44.0-rc.1', 'v1.0.0', 'unknown'])
      await assert.rejects(
        new GoogleClient(fakeGoogle([], { version }), {}).checkVersion(
          {},
          workspace,
          googleConfiguration.account,
        ),
        { code: 'tool_unavailable' },
      );
  });
  it('should distinguish revoked authorization and refuse an unsupported executable version', async () => {
    await assert.rejects(
      store(root, [], { exitCode: 4 }).reconcile(
        'one',
        googleConfiguration.account,
        material(),
        workspace,
      ),
      { credentialRejected: true },
    );
    await assert.rejects(
      store(root, [], { version: 'v1.0.0' }).reconcile(
        'one',
        googleConfiguration.account,
        material(),
        workspace,
      ),
      { code: 'tool_unavailable' },
    );
    assert.equal(
      await store(root).inspect('one', googleConfiguration.account, material()),
      'missing',
    );
  });
});
