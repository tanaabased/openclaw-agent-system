import assert from 'node:assert/strict';

import parseSshPublicKey, { looksLikeSshPublicKey } from '../utils/parse-ssh-public-key.ts';

const publicKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev';

describe('utils/parse-ssh-public-key', () => {
  it('should canonicalize a supported openssh public key and ignore its comment', () => {
    assert.deepEqual(parseSshPublicKey(publicKey), {
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:6dlFAq8YbUfNEZep5XnC9SLWZDFEaN0AC/ZHApG4lsk',
      key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0',
    });
    assert.deepEqual(parseSshPublicKey(publicKey.replace(' tanaabot@tanaab.dev', '')), {
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:6dlFAq8YbUfNEZep5XnC9SLWZDFEaN0AC/ZHApG4lsk',
      key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0',
    });
  });

  it('should reject multiline, malformed, and mismatched public keys', () => {
    assert.throws(() => parseSshPublicKey(`${publicKey}\n${publicKey}`), /exactly one/u);
    assert.throws(() => parseSshPublicKey('ssh-ed25519 not-base64'), /base64/u);
    assert.throws(
      () => parseSshPublicKey(publicKey.replace('ssh-ed25519', 'ssh-rsa')),
      /does not match/u,
    );
  });

  it('should distinguish key-looking short forms from ordinary paths', () => {
    assert.equal(looksLikeSshPublicKey(publicKey), true);
    assert.equal(looksLikeSshPublicKey('keys/tanaabot.pub'), false);
    assert.equal(looksLikeSshPublicKey('ssh-keys/tanaabot.pub'), false);
    assert.equal(looksLikeSshPublicKey('ssh-ed25519 invalid'), true);
  });
});
