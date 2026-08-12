import assert from 'node:assert/strict';

import createGitHubLifecycleContribution from '../tools/github/lifecycle.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'data' },
  github: { config: { gitProtocol: 'https' } },
};
const context = { manifest, workspaceDir: '/workspace' };
const publicKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev';
const keyManifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'data' },
  github: {
    sshKeys: [{ source: publicKey, type: 'auto' }],
    sshSigningKeys: [{ source: 'keys/signing.pub', type: 'path' }],
    token: 'GH_TOKEN_DATA',
    username: 'data-user',
  },
};
const keyContext = { manifest: keyManifest, workspaceDir: '/workspace' };

describe('tools/github/lifecycle', () => {
  it('should validate and inspect generated github cli configuration', async () => {
    const contribution = createGitHubLifecycleContribution({
      configStore: {
        async inspect(agentId, configuration) {
          assert.equal(agentId, 'data');
          assert.equal(configuration.gitProtocol, 'https');
          return { configDir: '/private/data/tools/gh', status: 'ready' };
        },
        async reconcile() {
          throw new Error('reconcile should not run');
        },
      },
    });

    assert.deepEqual(contribution.validate?.(context), {
      code: 'github-config-valid',
      summary: 'GitHub tool configuration',
    });
    assert.deepEqual(await contribution.inspect?.(context), [
      {
        code: 'github-config-ready',
        message: 'Generated GitHub CLI config matches the agent manifest.',
        status: 'healthy',
      },
    ]);
  });

  it('should reconcile and verify generated github cli configuration', async () => {
    const events: string[] = [];
    const contribution = createGitHubLifecycleContribution({
      configStore: {
        async reconcile(agentId, configuration) {
          events.push(`reconcile:${agentId}:${configuration.gitProtocol}`);
          return { configDir: '/private/data/tools/gh', status: 'created' };
        },
        async inspect(agentId, configuration) {
          events.push(`inspect:${agentId}:${configuration.gitProtocol}`);
          return { configDir: '/private/data/tools/gh', status: 'ready' };
        },
      },
    });

    assert.deepEqual(await contribution.reconcile?.(context), {
      outcomes: [
        {
          code: 'create-github-config',
          message: 'private GitHub CLI config',
          status: 'created',
        },
      ],
    });
    assert.deepEqual(events, ['reconcile:data:https', 'inspect:data:https']);
  });

  it('should report verified matching configuration as unchanged', async () => {
    const contribution = createGitHubLifecycleContribution({
      configStore: {
        async reconcile() {
          return { configDir: '/private/data/tools/gh', status: 'unchanged' };
        },
        async inspect() {
          return { configDir: '/private/data/tools/gh', status: 'ready' };
        },
      },
    });

    assert.deepEqual(await contribution.reconcile?.(context), {
      outcomes: [
        {
          code: 'github-config-unchanged',
          message: 'private GitHub CLI config',
          status: 'unchanged',
        },
      ],
    });
  });

  it('should convert unsafe inspection into a repair finding', async () => {
    const contribution = createGitHubLifecycleContribution({
      configStore: {
        async inspect() {
          throw new Error('The generated GitHub config must be private.');
        },
        async reconcile() {
          throw new Error('reconcile should not run');
        },
      },
    });

    assert.deepEqual(await contribution.inspect?.(context), [
      {
        code: 'github-config-unsafe',
        message: 'The generated GitHub config must be private.',
        remediation: 'Correct the private config path, then run openclaw agent-system install.',
        status: 'drift',
      },
    ]);
  });

  it('should require explicit identity and credential bindings for github account keys', () => {
    const contribution = createGitHubLifecycleContribution({
      configStore: {
        async inspect() {
          throw new Error('inspect should not run');
        },
        async reconcile() {
          throw new Error('reconcile should not run');
        },
      },
    });
    const result = contribution.validate?.({
      manifest: {
        schemaVersion: 1,
        agent: { id: 'data' },
        github: { sshKeys: [{ source: publicKey, type: 'auto' }] },
      },
      workspaceDir: '/workspace',
    });

    assert.deepEqual(
      result?.diagnostics?.map(({ code, fieldPath }) => ({ code, fieldPath })),
      [
        {
          code: 'github-account-key-username-required',
          fieldPath: '/github/username',
        },
        { code: 'github-account-key-token-required', fieldPath: '/github/token' },
      ],
    );
  });

  it('should present account key readiness and drift through github doctor findings', async () => {
    const contribution = createGitHubLifecycleContribution({
      accountKeyService: {
        async inspect(input) {
          assert.deepEqual(input, keyContext);
          return [
            { category: 'ssh', declared: 1, missingFingerprints: [], status: 'ready' },
            {
              category: 'ssh-signing',
              declared: 1,
              missingFingerprints: ['SHA256:missing'],
              status: 'missing',
            },
          ];
        },
        async reconcile() {
          throw new Error('reconcile should not run');
        },
      },
      configStore: {
        async inspect() {
          return { configDir: '/private/data/tools/gh', status: 'ready' };
        },
        async reconcile() {
          throw new Error('reconcile should not run');
        },
      },
    });

    assert.deepEqual(await contribution.inspect?.(keyContext), [
      {
        code: 'github-config-ready',
        message: 'Generated GitHub CLI config matches the agent manifest.',
        status: 'healthy',
      },
      {
        code: 'github-ssh-keys-ready',
        message: 'GitHub SSH authentication keys match the manifest (1 declared).',
        status: 'healthy',
      },
      {
        code: 'github-ssh-signing-keys-drift',
        message: 'GitHub SSH signing keys are missing: SHA256:missing.',
        remediation: 'Run openclaw agent-system install from this workspace.',
        status: 'drift',
      },
    ]);
  });

  it('should reconcile account keys after verifying private github config', async () => {
    const events: string[] = [];
    const contribution = createGitHubLifecycleContribution({
      accountKeyService: {
        async inspect() {
          throw new Error('inspect should not run');
        },
        async reconcile(input) {
          assert.deepEqual(input, keyContext);
          events.push('keys');
          return [
            { category: 'ssh', created: 1, declared: 1 },
            { category: 'ssh-signing', created: 0, declared: 1 },
          ];
        },
      },
      configStore: {
        async reconcile() {
          events.push('config');
          return { configDir: '/private/data/tools/gh', status: 'unchanged' };
        },
        async inspect() {
          events.push('verify-config');
          return { configDir: '/private/data/tools/gh', status: 'ready' };
        },
      },
    });

    assert.deepEqual(await contribution.reconcile?.(keyContext), {
      outcomes: [
        {
          code: 'github-config-unchanged',
          message: 'private GitHub CLI config',
          status: 'unchanged',
        },
        {
          code: 'add-github-ssh-keys',
          message: '1 GitHub SSH authentication key',
          status: 'created',
        },
        {
          code: 'github-ssh-signing-keys-unchanged',
          message: '1 GitHub SSH signing key',
          status: 'unchanged',
        },
      ],
    });
    assert.deepEqual(events, ['config', 'verify-config', 'keys']);
  });
});
