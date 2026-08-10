import assert from 'node:assert/strict';

import AgentSystemToolError from '../lib/tool-error.ts';
import { gitIdentityEnvironment, resolveGitIdentity } from '../tools/git/identity.ts';

describe('tools/git/identity', () => {
  it('should prefer git identity and project child-only git configuration', () => {
    const identity = resolveGitIdentity(
      {
        agent: { email: 'agent@example.com', name: 'Agent Name' },
        git: { email: { fromEnvironment: 'GIT_EMAIL' }, name: 'Git Name' },
      },
      {
        resolve(value) {
          return typeof value === 'string' ? value : 'git@example.com';
        },
      },
    );

    assert.deepEqual(identity, { email: 'git@example.com', name: 'Git Name' });
    const environment = gitIdentityEnvironment(identity, 'darwin', ['town']);
    assert.equal(environment.GIT_AUTHOR_NAME, 'Git Name');
    assert.equal(environment.GIT_COMMITTER_EMAIL, 'git@example.com');
    assert.equal(environment.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(environment.GIT_CONFIG_KEY_3, 'core.hooksPath');
    assert.equal(environment.GIT_CONFIG_VALUE_3, '/dev/null');
    assert.equal(environment.GIT_CONFIG_KEY_4, 'credential.helper');
    assert.equal(environment.GIT_CONFIG_VALUE_4, '');
    assert.equal(environment.GIT_CONFIG_KEY_5, 'alias.town');
    assert.equal(environment.GIT_CONFIG_VALUE_5, '');
    assert.equal(environment.GIT_CONFIG_COUNT, '6');
  });

  it('should fail with a stable configuration error when effective identity is unavailable', () => {
    assert.throws(
      () =>
        resolveGitIdentity(
          { agent: { name: 'Agent Name' }, git: {} },
          { resolve: (value) => String(value) },
        ),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'configuration_unavailable',
    );
  });
});
