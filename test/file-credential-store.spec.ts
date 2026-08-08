import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import FileCredentialStore, {
  resolveFileCredentialStoreRoot,
} from '../lib/file-credential-store.ts';

const key = { agentId: 'data', credentialId: 'op' };

describe('lib/file-credential-store', () => {
  let temporaryDirectory: string;
  let rootDir: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-credentials-'));
    rootDir = join(temporaryDirectory, 'config', 'tanaab', 'agent-system');
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it('should store, replace, read, and idempotently remove an agent credential', async () => {
    const store = new FileCredentialStore({ currentUid: process.getuid?.(), rootDir });

    assert.deepEqual(await store.write(key, 'private-one'), { status: 'stored' });
    assert.deepEqual(await store.write(key, 'private-one'), { status: 'unchanged' });
    assert.deepEqual(await store.write(key, 'private-two'), { status: 'stored' });
    assert.deepEqual(await store.read(key), { status: 'found', value: 'private-two' });
    assert.deepEqual(await store.remove(key), { status: 'removed' });
    assert.deepEqual(await store.remove(key), { status: 'missing' });
  });

  it('should create owner-only directories and files', async () => {
    const store = new FileCredentialStore({ currentUid: process.getuid?.(), rootDir });
    const agentDir = join(rootDir, 'data');
    const credentialPath = join(agentDir, 'op-token');

    assert.deepEqual(await store.write(key, 'private-token'), { status: 'stored' });

    assert.equal((await stat(rootDir)).mode & 0o077, 0);
    assert.equal((await stat(agentDir)).mode & 0o077, 0);
    assert.equal((await stat(credentialPath)).mode & 0o077, 0);
    assert.equal(await readFile(credentialPath, 'utf8'), 'private-token');
  });

  it('should reject a symbolic-link credential without changing its target', async () => {
    const store = new FileCredentialStore({ currentUid: process.getuid?.(), rootDir });
    const credentialPath = join(rootDir, 'data', 'op-token');
    const targetPath = join(temporaryDirectory, 'target');
    await store.write(key, 'private-token');
    await unlink(credentialPath);
    await symlink(targetPath, credentialPath);

    const result = await store.write(key, 'replacement');

    assert.equal(result.status, 'unsafe');
    assert.equal(await readFile(targetPath, 'utf8').catch(() => 'missing'), 'missing');
  });

  it('should reject a credential file with group or other permissions', async () => {
    const store = new FileCredentialStore({ currentUid: process.getuid?.(), rootDir });
    const credentialPath = join(rootDir, 'data', 'op-token');
    await store.write(key, 'private-token');
    await chmod(credentialPath, 0o644);

    const result = await store.read(key);

    assert.equal(result.status, 'unsafe');
    if (result.status !== 'unsafe') return;
    assert.equal(result.code, 'credential-file-permissions');
  });

  it('should reject identifiers that could escape the store root', async () => {
    const store = new FileCredentialStore({ currentUid: process.getuid?.(), rootDir });

    const result = await store.write({ agentId: '../other', credentialId: 'op' }, 'private-token');

    assert.equal(result.status, 'unavailable');
  });

  it('should reject oversized credential values before creating store state', async () => {
    const store = new FileCredentialStore({ currentUid: process.getuid?.(), rootDir });

    const result = await store.write(key, 'x'.repeat(64 * 1024 + 1));

    assert.equal(result.status, 'unsafe');
    assert.equal(
      await stat(rootDir)
        .then(() => 'exists')
        .catch(() => 'missing'),
      'missing',
    );
  });

  it('should prefer an absolute xdg root and reject relative roots', () => {
    assert.equal(
      resolveFileCredentialStoreRoot({ XDG_CONFIG_HOME: '/config', HOME: '/home/data' }),
      '/config/tanaab/agent-system',
    );
    assert.equal(
      resolveFileCredentialStoreRoot({ HOME: '/home/data' }),
      '/home/data/.config/tanaab/agent-system',
    );
    assert.equal(
      resolveFileCredentialStoreRoot({ XDG_CONFIG_HOME: 'relative', HOME: '/home/data' }),
      undefined,
    );
  });
});
