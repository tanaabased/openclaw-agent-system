import assert from 'node:assert/strict';

import AgentSystemToolError from '../lib/tool-error.ts';
import {
  isGitPrivateKeyFileSafe,
  loadGitPrivateKeySources,
  resolveGitPrivateKeyPath,
} from '../tools/git/private-key-source.ts';

describe('tools/git/private-key-source', () => {
  it('should accept only owner-only regular private key file metadata', () => {
    const metadata = { isFile: () => true, mode: 0o100600, size: 256, uid: 501 };
    assert.equal(isGitPrivateKeyFileSafe(metadata, 501), true);
    assert.equal(isGitPrivateKeyFileSafe({ ...metadata, mode: 0o100640 }, 501), false);
    assert.equal(isGitPrivateKeyFileSafe({ ...metadata, uid: 502 }, 501), false);
    assert.equal(isGitPrivateKeyFileSafe({ ...metadata, isFile: () => false }, 501), false);
    assert.equal(isGitPrivateKeyFileSafe({ ...metadata, size: 65_537 }, 501), false);
  });

  it('should resolve explicit home, absolute, and contained workspace paths', () => {
    assert.equal(
      resolveGitPrivateKeyPath('keys/id_ed25519', '/workspace', '/home/data'),
      '/workspace/keys/id_ed25519',
    );
    assert.equal(
      resolveGitPrivateKeyPath('~/.ssh/id_ed25519', '/workspace', '/home/data'),
      '/home/data/.ssh/id_ed25519',
    );
    assert.equal(
      resolveGitPrivateKeyPath('/run/keys/id_ed25519', '/workspace', '/home/data'),
      '/run/keys/id_ed25519',
    );
  });

  it('should reject relative workspace escapes and unsupported home syntax', () => {
    assert.throws(() => resolveGitPrivateKeyPath('../id_ed25519', '/workspace'));
    assert.throws(() => resolveGitPrivateKeyPath('~data/.ssh/id_ed25519', '/workspace'));
    assert.throws(() => resolveGitPrivateKeyPath('~/.ssh/id_ed25519', '/workspace'));
  });

  it('should load only declared environment and file sources in order', async () => {
    const reads: Array<{ currentUid?: number; path: string }> = [];
    const result = await loadGitPrivateKeySources(
      [{ path: 'keys/id_ed25519' }, { fromEnvironment: 'GIT_SSH_PRIVATE_KEY' }],
      {
        currentUid: 501,
        homeDirectory: '/home/data',
        resolveEnvironment(name) {
          assert.equal(name, 'GIT_SSH_PRIVATE_KEY');
          return 'environment-private-key';
        },
        workspaceDir: '/workspace',
      },
      {
        async readPrivateKeyFile(path, currentUid) {
          reads.push({ ...(currentUid === undefined ? {} : { currentUid }), path });
          return 'file-private-key';
        },
      },
    );

    assert.deepEqual(result, ['file-private-key', 'environment-private-key']);
    assert.deepEqual(reads, [{ currentUid: 501, path: '/workspace/keys/id_ed25519' }]);
  });

  it('should hide unavailable or invalid private key details behind one stable error', async () => {
    await assert.rejects(
      loadGitPrivateKeySources([{ fromEnvironment: 'GIT_SSH_PRIVATE_KEY' }], {
        resolveEnvironment: () => undefined,
        workspaceDir: '/workspace',
      }),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'credential_unavailable',
    );
  });
});
