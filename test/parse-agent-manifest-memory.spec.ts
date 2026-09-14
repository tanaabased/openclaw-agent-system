import assert from 'node:assert/strict';

import parseAgentManifest from '../manifest/parse.ts';

function parseMemory(search: string) {
  return parseAgentManifest(`
schema-version: 1
agent:
  id: emori
memory:
  search:
${search}
`);
}

describe('manifest/memory-schema', () => {
  it('should accept keyword-only and managed local provider selections', () => {
    for (const provider of ['none', 'local']) {
      const result = parseMemory(`    provider: ${provider}`);

      assert.equal(result.status, 'valid');
      if (result.status !== 'valid') continue;
      assert.deepEqual(result.manifest.memory, { search: { provider } });
    }
  });

  it('should accept optional openai model and environment binding', () => {
    const result = parseMemory(`    provider: openai
    model: text-embedding-3-small
    api-key: EMBEDDINGS_API_KEY`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.memory, {
      search: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        apiKey: 'EMBEDDINGS_API_KEY',
      },
    });
  });

  it('should accept openai with native credential and model defaults', () => {
    const result = parseMemory('    provider: openai');

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.memory, { search: { provider: 'openai' } });
  });

  it('should reject provider-inappropriate fields and malformed bindings', () => {
    for (const source of [
      `    provider: none
    model: text-embedding-3-small`,
      `    provider: local
    api-key: LOCAL_API_KEY`,
      `    provider: openai
    api-key: lower-case-key`,
      `    provider: openai
    base-url: https://example.com`,
    ]) {
      const result = parseMemory(source);

      assert.equal(result.status, 'invalid');
      assert.equal(
        result.diagnostics.some(
          ({ code }) => code === 'manifest-unknown-key' || code === 'manifest-schema',
        ),
        true,
      );
    }
  });

  it('should leave memory unmanaged when the section is omitted', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: emori
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.equal(result.manifest.memory, undefined);
  });
});
