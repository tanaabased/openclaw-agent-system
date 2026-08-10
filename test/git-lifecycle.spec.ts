import assert from 'node:assert/strict';

import createGitLifecycleContribution from '../tools/git/lifecycle.ts';

describe('tools/git/lifecycle', () => {
  it('should accept identity inherited from the agent section', () => {
    const contribution = createGitLifecycleContribution();

    assert.deepEqual(
      contribution.validate?.({
        manifest: {
          schemaVersion: 1,
          agent: { id: 'data', email: 'data@example.com', name: 'Data' },
          git: {},
        },
        workspaceDir: '/workspace',
      }),
      {
        code: 'git-config-valid',
        summary: 'Git tool identity and policy configuration',
      },
    );
  });

  it('should require declared identity and warn when unknown operations are allowed', () => {
    const contribution = createGitLifecycleContribution();
    const result = contribution.validate?.({
      manifest: {
        schemaVersion: 1,
        agent: { id: 'data' },
        git: { policy: { unknown: 'allow' } },
      },
      workspaceDir: '/workspace',
    });

    assert.deepEqual(
      result?.diagnostics?.map(({ code, severity }) => ({ code, severity })),
      [
        { code: 'git-name-required', severity: 'error' },
        { code: 'git-email-required', severity: 'error' },
        { code: 'git-policy-unknown-allowed', severity: 'warning' },
      ],
    );
  });

  it('should inspect openssh readiness only when managed ssh is configured', async () => {
    let inspections = 0;
    const contribution = createGitLifecycleContribution({
      sshResourceService: {
        async inspectDependencies() {
          inspections += 1;
          return { missing: [] };
        },
      },
    });

    assert.deepEqual(
      await contribution.inspect?.({
        manifest: {
          schemaVersion: 1,
          agent: { id: 'data', email: 'data@example.com', name: 'Data' },
          git: {},
        },
        workspaceDir: '/workspace',
      }),
      [],
    );
    assert.equal(inspections, 0);
    assert.deepEqual(
      await contribution.inspect?.({
        manifest: {
          schemaVersion: 1,
          agent: { id: 'data', email: 'data@example.com', name: 'Data' },
          git: {
            ssh: { privateKeys: [{ fromEnvironment: 'GIT_SSH_PRIVATE_KEY' }] },
          },
        },
        workspaceDir: '/workspace',
      }),
      [
        {
          code: 'git-ssh-dependencies-ready',
          message: 'Git SSH authentication dependencies are available.',
          status: 'healthy',
        },
      ],
    );
    assert.equal(inspections, 1);
  });

  it('should report missing openssh dependencies as blocked', async () => {
    const contribution = createGitLifecycleContribution({
      sshResourceService: {
        async inspectDependencies() {
          return { missing: ['ssh-agent', 'ssh-add'] };
        },
      },
    });

    assert.deepEqual(
      await contribution.inspect?.({
        manifest: {
          schemaVersion: 1,
          agent: { id: 'data', email: 'data@example.com', name: 'Data' },
          git: {
            ssh: { privateKeys: [{ path: '/run/keys/id_ed25519' }] },
          },
        },
        workspaceDir: '/workspace',
      }),
      [
        {
          code: 'git-ssh-dependencies-missing',
          message: 'Git SSH authentication requires missing executables: ssh-agent, ssh-add.',
          remediation: 'Install OpenSSH and make ssh, ssh-agent, and ssh-add available on PATH.',
          status: 'blocked',
        },
      ],
    );
  });
});
