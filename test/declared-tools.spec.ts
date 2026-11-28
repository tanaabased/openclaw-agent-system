import assert from 'node:assert/strict';
import { normalizeAgentManifest } from '../manifest/parse.ts';

describe('declared tools', () => {
  const tool = { executable: './bin/netlify', environment: ['NETLIFY_AUTH_TOKEN'] };
  const parse = (tools: unknown) =>
    normalizeAgentManifest({ 'schema-version': 1, agent: { id: 'test' }, tools });
  it('preserves tool identifiers and environment names', () => {
    const result = parse({ 'site-cli': tool });
    assert.equal(result.status, 'valid');
    assert.deepEqual(result.manifest.tools, { 'site-cli': tool });
  });
  it('rejects launcher collisions, invalid filenames and bootstrap credentials', () => {
    for (const id of ['git', 'gh', '../netlify', 'agent-system-tool']) {
      assert.equal(parse({ [id]: tool }).status, 'invalid');
    }
    assert.equal(
      parse({ site: { ...tool, environment: ['OP_SERVICE_ACCOUNT_TOKEN'] } }).status,
      'invalid',
    );
  });
});
