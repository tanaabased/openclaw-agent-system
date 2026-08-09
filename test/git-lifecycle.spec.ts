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
});
