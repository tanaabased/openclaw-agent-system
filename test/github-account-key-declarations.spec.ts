import assert from 'node:assert/strict';

import {
  githubAccountKeyCategories,
  validateGitHubAccountKeyDeclarations,
} from '../tools/github/account-key-declarations.ts';

const publicKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev';

function diagnosticIdentity(diagnostics: ReturnType<typeof validateGitHubAccountKeyDeclarations>) {
  return diagnostics.map(({ code, fieldPath }) => ({ code, fieldPath }));
}

describe('tools/github/account-key-declarations', () => {
  it('should normalize configured categories in authentication then signing order', () => {
    const sshKey = { source: 'keys/auth.pub', type: 'path' as const };
    const signingKey = { source: 'keys/signing.pub', type: 'path' as const };

    assert.deepEqual(
      githubAccountKeyCategories({
        sshSigningKeys: [signingKey],
        sshKeys: [sshKey],
      }),
      [
        {
          category: 'ssh',
          endpoint: '/user/keys',
          label: 'SSH authentication',
          sources: [sshKey],
        },
        {
          category: 'ssh-signing',
          endpoint: '/user/ssh_signing_keys',
          label: 'SSH signing',
          sources: [signingKey],
        },
      ],
    );
  });

  it('should remain inactive when no account keys are declared', () => {
    assert.deepEqual(githubAccountKeyCategories({}), []);
    assert.deepEqual(validateGitHubAccountKeyDeclarations({}), []);
  });

  it('should require explicit identity and credential bindings for account keys', () => {
    assert.deepEqual(
      diagnosticIdentity(
        validateGitHubAccountKeyDeclarations({
          sshKeys: [{ source: 'keys/auth.pub', type: 'path' }],
        }),
      ),
      [
        { code: 'github-account-key-username-required', fieldPath: '/github/username' },
        { code: 'github-account-key-token-required', fieldPath: '/github/token' },
      ],
    );
  });

  it('should reject malformed key-looking sources without misclassifying key-named paths', () => {
    assert.deepEqual(
      diagnosticIdentity(
        validateGitHubAccountKeyDeclarations({
          sshKeys: [
            { source: 'ssh-ed25519 invalid', type: 'auto' },
            { source: 'ssh-keys/tanaabot.pub', type: 'auto' },
          ],
          token: 'GH_TOKEN_TANAABOT',
          username: 'tanaabot',
        }),
      ),
      [{ code: 'github-account-key-invalid', fieldPath: '/github/ssh-keys/0' }],
    );
  });

  it('should reject invalid tilde paths and duplicate inline keys', () => {
    assert.deepEqual(
      diagnosticIdentity(
        validateGitHubAccountKeyDeclarations({
          sshKeys: [
            { source: '~other/key.pub', type: 'path' },
            { source: publicKey, type: 'key' },
            { source: publicKey, type: 'auto' },
          ],
          token: 'GH_TOKEN_TANAABOT',
          username: 'tanaabot',
        }),
      ),
      [
        { code: 'github-account-key-path-invalid', fieldPath: '/github/ssh-keys/0' },
        { code: 'github-account-key-duplicate', fieldPath: '/github/ssh-keys/2' },
      ],
    );
  });
});
