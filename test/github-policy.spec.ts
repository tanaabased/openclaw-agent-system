import assert from 'node:assert/strict';

import { authorizeGitHubOperation, classifyGitHubOperation } from '../tools/github/policy.ts';

function selectsReleasesPolicy(argv: string[]): boolean {
  return classifyGitHubOperation({ argv }).attributes?.['github.policy.releases'] === true;
}

describe('tools/github/policy', () => {
  it('should retain read and write risk metadata without using it for authorization', () => {
    for (const argv of [
      ['--help'],
      ['-h'],
      ['--version'],
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
      ['repo', 'edit', 'owner/repository', '--visibility', 'private'],
      ['repo', 'vaporize', 'owner/repository'],
    ]) {
      assert.equal(classifyGitHubOperation({ argv }).risk, 'write');
      assert.equal(
        authorizeGitHubOperation(classifyGitHubOperation({ argv }), {}).status,
        'allowed',
      );
    }

    const deletion = classifyGitHubOperation({
      argv: ['repo', 'delete', 'owner/repository', '--yes'],
    });
    assert.equal(deletion.risk, 'destructive');
    assert.equal(authorizeGitHubOperation(deletion, {}).status, 'allowed');
  });

  it('should allow release reads and select release mutations', () => {
    for (const argv of [
      ['release', 'list'],
      ['release', 'ls'],
      ['release', 'view', 'v1.0.0'],
      ['release', 'download', 'v1.0.0'],
      ['release', 'create', '--help'],
      ['release', '--repo', 'owner/repository', 'list'],
    ]) {
      assert.equal(classifyGitHubOperation({ argv }).risk, 'read');
      assert.equal(selectsReleasesPolicy(argv), false);
    }
    for (const argv of [
      ['release', 'create', 'v1.0.0'],
      ['release', 'edit', 'v1.0.0'],
      ['release', 'delete', 'v1.0.0'],
      ['release', 'upload', 'v1.0.0', 'artifact.zip'],
      ['release', 'delete-asset', 'v1.0.0', 'artifact.zip'],
      ['release', 'future-mutation', 'v1.0.0'],
      ['release', 'create', 'v1.0.0', '--notes', '-h'],
      ['release', '-R', 'owner/repository', 'create', 'v1.0.0'],
    ]) {
      assert.equal(selectsReleasesPolicy(argv), true);
    }
  });

  it('should select mutating release api routes while allowing reads and generated notes', () => {
    for (const argv of [
      ['api', '--method', 'POST', '/repos/{owner}/{repo}/releases'],
      ['api', '-XPATCH', 'repos/owner/repository/releases/123'],
      ['api', 'https://api.github.com/repos/owner/repository/releases/123', '-X', 'DELETE'],
      ['api', '-F', 'name=artifact.zip', '/repos/owner/repository/releases/assets/456'],
      ['api', '--input', '-', '/repos/owner/repository/releases/123/assets'],
      ['api', '--header', '-h', '--method', 'POST', '/repos/owner/repository/releases'],
      ['api', '--preview', 'corsair', '--method', 'POST', '/repos/owner/repository/releases'],
      [
        'api',
        '--future-option',
        'future-value',
        '--method',
        'POST',
        '/repos/owner/repository/releases',
      ],
    ]) {
      assert.equal(selectsReleasesPolicy(argv), true);
    }
    for (const argv of [
      ['api', '/repos/owner/repository/releases'],
      ['api', '--method=GET', '/repos/owner/repository/releases/123'],
      ['api', '--method', 'POST', '/repos/owner/repository/releases/generate-notes'],
      ['api', '--method', 'DELETE', '/repos/owner/repository/issues/comments/123'],
      ['api', '--method', 'PATCH', '/repos/owner/repository/git/refs/tags/v1.0.0'],
    ]) {
      assert.equal(selectsReleasesPolicy(argv), false);
      assert.equal(
        authorizeGitHubOperation(classifyGitHubOperation({ argv }), {}).status,
        'allowed',
      );
    }
  });

  it('should deny release mutations by default with one explicit override', () => {
    const release = classifyGitHubOperation({ argv: ['release', 'create', 'v1.0.0'] });

    const denied = authorizeGitHubOperation(release, {});
    assert.equal(denied.status, 'denied');
    assert.match(denied.reason, /denied by github\.policy\.releases/u);
    assert.match(denied.reason, /operator must set github\.policy\.releases to allow/u);
    assert.equal(
      authorizeGitHubOperation(release, { policy: { releases: 'allow' } }).status,
      'allowed',
    );
  });
});
