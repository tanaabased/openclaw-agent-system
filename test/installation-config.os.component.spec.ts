import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import readInstallationConfig from '../core/installation-config.ts';

describe('core/installation-config file boundary', () => {
  let root: string;
  let directory: string;
  let path: string;
  beforeEach(async () => {
    root = await mkdtemp('/tmp/installation-config-');
    directory = join(root, 'tanaab', 'agent-system');
    path = join(directory, 'config.yaml');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const read = () => readInstallationConfig({ XDG_CONFIG_HOME: root });

  it('should read a missing file without creating directories and refresh private settings', async () => {
    const missing = await read();
    assert.equal(missing.status === 'ready' && missing.graceMinutes, 60);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, 'schema-version: 1\ncleanup: {grace-minutes: 5}', { mode: 0o600 });
    const configured = await read();
    assert.equal(configured.status === 'ready' && configured.graceMinutes, 5);
    await writeFile(path, 'schema-version: 1\ncleanup: {grace-minutes: 7}');
    const updated = await read();
    assert.equal(updated.status === 'ready' && updated.graceMinutes, 7);
  });

  for (const unsafe of ['symlink', 'directory', 'public', 'oversized', 'invalid-utf8'] as const)
    it(`should block ${unsafe} configuration without treating it as absent`, async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (unsafe === 'symlink') await symlink(join(root, 'absent'), path);
      else if (unsafe === 'directory') await mkdir(path);
      else {
        await writeFile(
          path,
          unsafe === 'oversized'
            ? 'x'.repeat(65537)
            : unsafe === 'invalid-utf8'
              ? Buffer.from([255])
              : 'schema-version: 1',
          { mode: 0o600 },
        );
        if (unsafe === 'public') await chmod(path, 0o644);
      }
      assert.equal((await read()).status, 'blocked');
    });
});
