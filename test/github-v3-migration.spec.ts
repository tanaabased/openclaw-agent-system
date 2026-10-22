import assert from 'node:assert/strict';
import { parse } from 'yaml';
import githubV3Migration from '../manifest/github-v3-migration.ts';
import type { AgentManifestLoadResult } from '../manifest/load.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('manifest/github-v3-migration', () => {
  function fixture() {
    const policy = intakeFixture().policy;
    // Migration decisions consume the shared runtime policy, not legacy YAML fixtures.
    policy.schemaVersion = 2;
    const loaded = {
      status: 'loaded',
      manifest: { schemaVersion: 1, agent: { id: 'test' }, github: { notifications: policy } },
      path: '/workspace/agent.yaml',
      overlayPath: '/workspace/agent.local.yaml',
    } as Extract<AgentManifestLoadResult, { status: 'loaded' }>;
    return { policy, loaded };
  }
  it('should preview effective settings and both source files without modifying policy', () => {
    const { loaded, policy } = fixture();
    const previous = structuredClone(policy);
    const result = githubV3Migration(loaded);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.sources, [loaded.path, loaded.overlayPath]);
    const github = parse(result.yaml!).github;
    assert.equal(github['schema-version'], 3);
    assert.equal(github['issue-assignment'].mode, 'plan');
    assert.deepEqual(github['issue-assignment'].allowed, [
      { login: 'receiver', 'node-id': 'U_receiver' },
    ]);
    assert.deepEqual(policy, previous);
  });
  it('should require operator resolution for narrower feedback and recipient overrides', () => {
    const { loaded, policy } = fixture();
    policy.issueAssignment!.feedback = false;
    policy.issueAssignment!.pullRequest = { recipients: [] };
    const result = githubV3Migration(loaded);
    assert.equal(result.status, 'requires-resolution');
    assert.deepEqual(
      result.resolutions.map(({ code }) => code),
      ['github-v3-recipient-resolution', 'github-v3-feedback-resolution'],
    );
  });
  it('should distinguish unchanged feedback unions from changed grants', () => {
    const { loaded, policy } = fixture();
    const reviewer = { login: 'reviewer', nodeId: 'U_reviewer' };
    policy.issueAssignment!.pullRequest = {
      recipients: [
        { source: 'assignment-actor', roles: ['assignee'] },
        { ...reviewer, roles: ['reviewer'] },
      ],
    };
    policy.issueAssignment!.feedback = { inherit: true, allowed: [reviewer] };
    assert.equal(githubV3Migration(loaded).status, 'ready');
    policy.issueAssignment!.feedback = { inherit: false, allowed: [reviewer] };
    assert.equal(githubV3Migration(loaded).status, 'requires-resolution');
  });
  it('should leave an already selected v3 policy intact', () => {
    const { loaded, policy } = fixture();
    policy.schemaVersion = 3;
    assert.equal(githubV3Migration(loaded).status, 'already-v3');
    assert.equal(githubV3Migration(loaded).yaml, undefined);
  });
});
