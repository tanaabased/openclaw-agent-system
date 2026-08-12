import assert from 'node:assert/strict';

import { authorizeGitHubOperation, classifyGitHubOperation } from '../tools/github/policy.ts';

describe('tools/github/policy', () => {
  it('should classify common read and write command shapes without a command catalog', () => {
    for (const argv of [
      ['repo', 'view', 'tanaabased/openclaw-agent-system'],
      ['issue', 'list'],
      ['search', 'code', 'AgentSystemToolRuntime'],
      ['api', 'user'],
    ]) {
      assert.equal(classifyGitHubOperation({ argv }).risk, 'read');
    }
    for (const argv of [
      ['issue', 'create', '--title', 'Example'],
      ['pr', 'merge', '12'],
      ['project', 'item-add', '1'],
      ['workflow', 'run', 'ci.yml'],
    ]) {
      assert.equal(classifyGitHubOperation({ argv }).risk, 'write');
    }
  });

  it('should classify destructive operations before unknown policy can apply', () => {
    for (const input of [
      { argv: ['repo', 'delete', 'owner/repository', '--yes'] },
      { argv: ['release', 'delete-asset', 'v1.0.0', 'artifact.zip'] },
      { argv: ['pr', 'merge', '12', '--delete-branch'] },
      { argv: ['api', '--method', 'DELETE', '/user/keys/123'] },
      {
        argv: ['api', 'graphql', '--input', '-'],
        stdin: '{"query":"mutation DeleteThing { deleteIssue(input: {}) { clientMutationId } }"}',
      },
    ]) {
      assert.equal(classifyGitHubOperation(input).risk, 'destructive');
    }
  });

  it('should classify privilege and repository-control operations as admin', () => {
    for (const argv of [
      ['repo', 'edit', 'owner/repository', '--visibility', 'private'],
      ['pr', 'merge', '12', '--admin'],
      ['secret', 'set', 'DEPLOY_TOKEN'],
      ['workflow', 'disable', 'ci.yml'],
      ['api', '--method', 'PUT', '/repos/owner/repository/collaborators/user'],
    ]) {
      assert.equal(classifyGitHubOperation({ argv }).risk, 'admin');
    }
  });

  it('should keep graphql reads readable and unfamiliar mutations unknown', () => {
    assert.equal(
      classifyGitHubOperation({
        argv: ['api', 'graphql', '--input', '-'],
        stdin: '{"query":"query Viewer { viewer { login } }"}',
      }).risk,
      'read',
    );
    assert.equal(
      classifyGitHubOperation({
        argv: [
          'api',
          'graphql',
          '-f',
          'owner=tanaabased',
          '-f',
          'query=query Viewer { viewer { login } }',
        ],
      }).risk,
      'read',
    );
    assert.equal(
      classifyGitHubOperation({ argv: ['repo', 'vaporize', 'owner/repository'] }).risk,
      'unknown',
    );
    assert.equal(
      classifyGitHubOperation({
        argv: ['api', '--method', 'POST', '/repos/owner/repository/issues'],
      }).risk,
      'unknown',
    );
  });

  it('should default hazards and unknown operations to deny with explicit overrides', () => {
    const destructive = classifyGitHubOperation({ argv: ['repo', 'delete', 'owner/repository'] });
    const admin = classifyGitHubOperation({ argv: ['repo', 'edit', 'owner/repository'] });
    const unknown = classifyGitHubOperation({ argv: ['repo', 'vaporize', 'owner/repository'] });

    const denied = authorizeGitHubOperation(destructive, {});
    assert.equal(denied.status, 'denied');
    assert.match(denied.reason, /denied by github\.policy\.destructive/u);
    assert.match(denied.reason, /operator must set github\.policy\.destructive to allow/u);
    assert.equal(authorizeGitHubOperation(admin, {}).status, 'denied');
    assert.equal(authorizeGitHubOperation(unknown, {}).status, 'denied');
    assert.equal(
      authorizeGitHubOperation(destructive, { policy: { destructive: 'allow' } }).status,
      'allowed',
    );
    assert.equal(authorizeGitHubOperation(admin, { policy: { admin: 'allow' } }).status, 'allowed');
    assert.equal(
      authorizeGitHubOperation(unknown, { policy: { unknown: 'allow' } }).status,
      'allowed',
    );
    assert.equal(
      authorizeGitHubOperation(destructive, { policy: { unknown: 'allow' } }).status,
      'denied',
    );
  });
});
