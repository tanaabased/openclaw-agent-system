import assert from 'node:assert/strict';

import resolveGitProtocol from '../tools/git/protocol.ts';
import { defaultGitHubCliConfiguration } from '../tools/github/config-schema.ts';

describe('tools/git/protocol', () => {
  it('should honor explicit https even with authentication keys declared', () => {
    assert.equal(
      resolveGitProtocol({
        git: { ssh: { privateKeys: [{ path: '/must-not-read/key' }] } },
        github: {
          config: { gitProtocol: 'https' },
          sshKeys: [{ type: 'path', source: '/must-not-read/key.pub' }],
        },
      }),
      'https',
    );
  });

  it('should infer ssh from either authentication declaration without resolving keys', () => {
    assert.equal(
      resolveGitProtocol({ git: { ssh: { privateKeys: [{ fromEnvironment: 'PRIVATE' }] } } }),
      'ssh',
    );
    assert.equal(
      resolveGitProtocol({ github: { sshKeys: [{ type: 'path', source: '/missing' }] } }),
      'ssh',
    );
  });

  it('should inherit the shared default for absent or signing-only authentication', () => {
    for (const manifest of [
      {},
      { git: { signing: { key: 'SIGNING_ONLY' } } },
      { github: { sshSigningKeys: [{ type: 'key' as const, source: 'SIGNING_ONLY' }] } },
    ])
      assert.equal(resolveGitProtocol(manifest), defaultGitHubCliConfiguration.gitProtocol);
  });
});
