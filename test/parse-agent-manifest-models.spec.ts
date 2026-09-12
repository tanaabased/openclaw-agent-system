import assert from 'node:assert/strict';

import parseAgentManifest from '../manifest/parse.ts';

function parseModels(models: string) {
  return parseAgentManifest(`
schema-version: 1
agent:
  id: emori
${models}
`);
}

describe('manifest/models-schema', () => {
  it('should accept an explicit default model profile without work tiers', () => {
    const result = parseModels(`models:
  default:
    model: openai/gpt-6-astra
    effort: high`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.models, {
      default: { model: 'openai/gpt-6-astra', effort: 'high' },
    });
  });

  it('should accept the complete additive work-tier group', () => {
    const result = parseModels(`models:
  default: { model: openai/gpt-6-astra, effort: high }
  low: { model: openai/gpt-5.6-terra, effort: medium }
  medium: { model: openai/gpt-5.6-sol, effort: high }
  high: { model: openai/gpt-6-astra, effort: xhigh }`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.models, {
      default: { model: 'openai/gpt-6-astra', effort: 'high' },
      low: { model: 'openai/gpt-5.6-terra', effort: 'medium' },
      medium: { model: 'openai/gpt-5.6-sol', effort: 'high' },
      high: { model: 'openai/gpt-6-astra', effort: 'xhigh' },
    });
  });

  it('should reject partial work tiers with one focused diagnostic', () => {
    const result = parseModels(`models:
  default: { model: openai/gpt-6-astra, effort: high }
  low: { model: openai/gpt-5.6-terra, effort: medium }`);

    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.diagnostics, [
      {
        code: 'manifest-model-tier-group-incomplete',
        fieldPath: '/models',
        message:
          'Model work tiers must declare low, medium, and high together. Missing: medium, high.',
        severity: 'error',
      },
    ]);
  });

  it('should reject missing profile fields, malformed refs, efforts, and unknown keys', () => {
    for (const [profile, expectedCode] of [
      ['{ model: gpt-6-astra, effort: high }', 'manifest-schema'],
      ['{ model: openai/gpt-6-astra@work, effort: high }', 'manifest-schema'],
      ['{ model: openai/gpt-6-astra }', 'manifest-required-key'],
      ['{ model: openai/gpt-6-astra, effort: low }', 'manifest-schema'],
      ['{ model: openai/gpt-6-astra, effort: high, runtime: codex }', 'manifest-unknown-key'],
    ] as const) {
      const result = parseModels(`models:\n  default: ${profile}`);
      assert.equal(result.status, 'invalid');
      assert.equal(
        result.diagnostics.some(({ code }) => code === expectedCode),
        true,
      );
    }
  });
});
