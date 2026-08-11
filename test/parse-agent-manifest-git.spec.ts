import assert from 'node:assert/strict';

import parseAgentManifest from '../utils/parse-agent-manifest.ts';

function diagnosticCodes(source: string): Set<string> {
  const result = parseAgentManifest(source);
  return new Set(result.diagnostics.map(({ code }) => code));
}

describe('utils/parse-agent-manifest', () => {
  it('should parse git worktree defaults and local repository overrides', () => {
    const defaults = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
git:
  worktrees: {}
`);
    const expanded = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
git:
  worktrees:
    root: .agent-system/worktrees
    repositories:
      root: .agent-system/repositories
      local:
        tanaabased/openclaw-agent-system: ~/tanaab/openclaw-agent-system
        canon: ../canon
`);

    assert.equal(defaults.status, 'valid');
    if (defaults.status === 'valid') {
      assert.deepEqual(defaults.manifest.git, { worktrees: {} });
    }
    assert.equal(expanded.status, 'valid');
    if (expanded.status === 'valid') {
      assert.deepEqual(expanded.manifest.git?.worktrees, {
        root: '.agent-system/worktrees',
        repositories: {
          root: '.agent-system/repositories',
          local: {
            'tanaabased/openclaw-agent-system': '~/tanaab/openclaw-agent-system',
            canon: '../canon',
          },
        },
      });
    }
  });

  it('should parse strict git identity and policy configuration', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
git:
  name: Tanaabot
  email:
    from-environment: GIT_EMAIL
  extensions:
    lfs: allow
    town: ask
  policy:
    delete: ask
    discard: deny
    force: ask
    rewrite: allow
    unknown: deny
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.git, {
      name: 'Tanaabot',
      email: { fromEnvironment: 'GIT_EMAIL' },
      extensions: {
        lfs: 'allow',
        town: 'ask',
      },
      policy: {
        delete: 'ask',
        discard: 'deny',
        force: 'ask',
        rewrite: 'allow',
        unknown: 'deny',
      },
    });
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
git:
  signing-key: private
`).has('manifest-unknown-key'),
      true,
    );
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
git:
  policy:
    destructive: ask
`).has('manifest-unknown-key'),
      true,
    );
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
git:
  extensions:
    Town: allow
`).has('manifest-unknown-key'),
      true,
    );
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
git:
  extensions:
    town: prompt
`).has('manifest-schema'),
      true,
    );
  });

  it('should normalize one or many git ssh private key sources', () => {
    const one = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
git:
  ssh:
    private-keys:
      from-environment: GIT_SSH_PRIVATE_KEY
`);
    const many = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
git:
  ssh:
    private-keys:
      - path: ~/.ssh/id_ed25519
      - from-environment: GIT_SSH_PRIVATE_KEY
`);

    assert.equal(one.status, 'valid');
    assert.equal(many.status, 'valid');
    if (one.status === 'valid') {
      assert.deepEqual(one.manifest.git?.ssh?.privateKeys, [
        { fromEnvironment: 'GIT_SSH_PRIVATE_KEY' },
      ]);
    }
    if (many.status === 'valid') {
      assert.deepEqual(many.manifest.git?.ssh?.privateKeys, [
        { path: '~/.ssh/id_ed25519' },
        { fromEnvironment: 'GIT_SSH_PRIVATE_KEY' },
      ]);
    }
  });

  it('should parse one environment-bound git signing key and public trust file', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
git:
  signing:
    key: GIT_SIGNING_KEY
    allowed-signers-file: .agent-system/allowed_signers
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.git?.signing, {
      allowedSignersFile: '.agent-system/allowed_signers',
      key: 'GIT_SIGNING_KEY',
    });
  });

  it('should reject literal, wrapped, path, and escaping git signing keys', () => {
    for (const signing of [
      'key: private-key-material',
      'key: { from-environment: GIT_SIGNING_KEY }',
      'key: { path: ~/.ssh/id_ed25519 }',
      'key: GIT_SIGNING_KEY\n    allowed-signers-file: ../allowed_signers',
    ]) {
      const codes = diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
git:
  signing:
    ${signing}
`);
      assert.equal(codes.has('manifest-schema') || codes.has('manifest-unknown-key'), true);
    }
  });

  it('should reject empty, ambiguous, and direct 1password git key sources', () => {
    for (const privateKeys of [
      '[]',
      '{ path: key, from-environment: GIT_SSH_PRIVATE_KEY }',
      '{ from-onepassword: op://vault/item/private-key }',
    ]) {
      assert.equal(
        diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
git:
  ssh:
    private-keys: ${privateKeys}
`).has(privateKeys.includes('from-') ? 'manifest-unknown-key' : 'manifest-schema'),
        true,
      );
    }
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
git:
  ssh:
    private-keys:
      - path: keys/id_ed25519
      - path: keys/id_ed25519
`).has('manifest-schema'),
      true,
    );
  });
});
