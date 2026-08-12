import assert from 'node:assert/strict';

import parseAgentManifest from '../utils/parse-agent-manifest.ts';

function diagnosticCodes(source: string): Set<string> {
  const result = parseAgentManifest(source);
  return new Set(result.diagnostics.map(({ code }) => code));
}

describe('utils/parse-agent-manifest', () => {
  it('should parse github identity and an environment-only credential binding', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  host: github.com
  username:
    from-environment: GITHUB_USERNAME
  token: GITHUB_TOKEN
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.github, {
      host: 'github.com',
      username: { fromEnvironment: 'GITHUB_USERNAME' },
      token: 'GITHUB_TOKEN',
    });
  });

  it('should parse optional github credentials and all supported cli config settings', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  config:
    git-protocol: ssh
    color-labels: disabled
    accessible-colors: enabled
    spinner: disabled
    telemetry: enabled
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.github, {
      config: {
        gitProtocol: 'ssh',
        colorLabels: 'disabled',
        accessibleColors: 'enabled',
        spinner: 'disabled',
        telemetry: 'enabled',
      },
    });
  });

  it('should parse the github releases policy decision', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  policy:
    releases: allow
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.github?.policy, {
      releases: 'allow',
    });
  });

  it('should reject legacy github ask decisions with exact migration guidance', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  policy:
    releases: ask
`);

    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.diagnostics, [
      {
        code: 'manifest-policy-ask-unsupported',
        fieldPath: '/github/policy/releases',
        message:
          'Policy decision ask at /github/policy/releases is no longer supported. An operator must choose deny or allow.',
        severity: 'error',
      },
    ]);
  });

  it('should reject unsupported github policy decisions and policy keys', () => {
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  policy:
    releases: prompt
`).has('manifest-schema'),
      true,
    );
    for (const field of ['admin', 'destructive', 'unknown']) {
      assert.equal(
        diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  policy:
    ${field}: deny
`).has('manifest-unknown-key'),
        true,
      );
    }
  });

  it('should normalize github ssh authentication and signing key short and object forms', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  ssh-keys:
    - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev
    - path: keys/generated-auth.pub
      title: Generated authentication key
  ssh-signing-keys:
    key: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev
    title: Tanaabot signing key
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.github, {
      username: 'tanaabot',
      token: 'GH_TOKEN_TANAABOT',
      sshKeys: [
        {
          source:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev',
          type: 'auto',
        },
        {
          source: 'keys/generated-auth.pub',
          title: 'Generated authentication key',
          type: 'path',
        },
      ],
      sshSigningKeys: [
        {
          source:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev',
          title: 'Tanaabot signing key',
          type: 'key',
        },
      ],
    });
  });

  it('should reject empty key arrays and ambiguous github key objects', () => {
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  ssh-keys: []
`).has('manifest-schema'),
      true,
    );
    const ambiguous = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  ssh-signing-keys:
    key: ssh-ed25519 invalid
    path: keys/signing.pub
`);
    assert.equal(ambiguous.status, 'invalid');
  });

  it('should reject literal-like github tokens and unknown github keys', () => {
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  token: github_pat_private
`).has('manifest-schema'),
      true,
    );
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  token: GITHUB_TOKEN
  api-url: https://api.github.com
`).has('manifest-unknown-key'),
      true,
    );
  });
});
