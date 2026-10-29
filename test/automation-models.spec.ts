import assert from 'node:assert/strict';

import automationModels from '../agent/automation-models.ts';
import { codexIntakeJobs } from '../agent/codex-intake-policy.ts';
import openclawIntakeJobs from '../agent/openclaw-intake-policy.ts';
import automationContent from '../manifest/automation-content.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';

const models = {
  default: { model: 'openai/default', effort: 'medium' as const },
  low: { model: 'openai/small', effort: 'high' as const },
  medium: { model: 'openai/middle', effort: 'medium' as const },
  high: { model: 'openai/large', effort: 'xhigh' as const },
};
function jobs(settings: Record<string, unknown> = {}) {
  const parsed = normalizeAutomations([
    { id: 'review', schedule: 'every 1 hour', prompt: 'Review.', ...settings },
  ]);
  assert.equal(parsed.status, 'valid');
  if (parsed.status !== 'valid') throw Error('invalid fixture');
  return parsed.automations as ResolvedAutomation[];
}
describe('agent/automation-models', () => {
  for (const runtime of ['openclaw', 'codex'] as const) {
    const native = (model: string) => (runtime === 'codex' ? model.slice(7) : model);
    const resolve = (settings: Record<string, unknown>) =>
      automationModels(jobs(settings), models, runtime)[0]!.overrides[runtime];
    it(`should resolve profiles and per-field precedence for ${runtime}`, () => {
      for (const selector of ['default', 'low', 'medium', 'high'] as const)
        assert.deepEqual(resolve({ model: selector }), {
          model: native(models[selector].model),
          effort: models[selector].effort,
        });
      assert.deepEqual(resolve({}), { model: native(models.default.model), effort: 'medium' });
      assert.deepEqual(
        resolve({
          model: 'openai/explicit',
          effort: 'low',
          overrides: { [runtime]: { effort: 'high' } },
        }),
        { model: native('openai/explicit'), effort: 'high' },
      );
      assert.deepEqual(
        resolve({
          model: 'low',
          overrides: { [runtime]: { model: runtime === 'codex' ? 'override' : 'openai/override' } },
        }),
        { model: native('openai/override'), effort: 'high' },
      );
      assert.deepEqual(resolve({ model: 'openai/explicit' }), {
        model: native('openai/explicit'),
        effort: 'medium',
      });
    });
    it(`should preserve inheritance and reject missing profiles and unowned settings for ${runtime}`, () => {
      const original = jobs();
      assert.deepEqual(automationModels(original, undefined, runtime), original);
      assert.deepEqual(
        automationModels(jobs({ effort: 'low' }), undefined, runtime)[0]!.overrides[runtime],
        { effort: 'low' },
      );
      assert.throws(
        () => automationModels(jobs({ model: 'low' }), { default: models.default }, runtime),
        { code: 'automation-model-profile-missing' },
      );
      assert.throws(
        () =>
          automationModels(
            jobs({ overrides: { [runtime]: { target: { thread: 'unowned' } } } }),
            models,
            runtime,
          ),
        { code: 'automation-thread-settings-unowned' },
      );
    });
    it(`should detect profile changes without changing schedule anchors for ${runtime}`, () => {
      const original = jobs();
      const before = automationContent(automationModels(original, models, runtime)[0]!, runtime);
      const after = automationContent(
        automationModels(
          original,
          { ...models, default: { ...models.default, model: 'openai/new' } },
          runtime,
        )[0]!,
        runtime,
      );
      assert.notEqual(before.hash, after.hash);
      assert.equal(before.triggerHash, after.triggerHash);
      assert.deepEqual(original[0]!.overrides, {});
    });
  }
  it('should project shared intent through both runtime entrypoints', () => {
    const manifest = {
      agent: { id: 'test' },
      automations: jobs({ model: 'low' }),
      models,
    } as AgentManifest;
    assert.deepEqual(openclawIntakeJobs(manifest)[0]!.overrides.openclaw, {
      model: 'openai/small',
      effort: 'high',
    });
    assert.deepEqual(codexIntakeJobs(manifest)[0]!.overrides.codex, {
      model: 'small',
      effort: 'high',
    });
  });
  it('should reject malformed shared settings and command settings in either payload form', () => {
    for (const fields of [{ model: 'missing' }, { model: 'openai/ bad' }, { effort: 'unknown' }])
      assert.equal(
        normalizeAutomations([
          { id: 'review', schedule: 'every 1 hour', prompt: 'Review.', ...fields },
        ]).status,
        'invalid',
      );
    for (const command of [{ run: 'true' }, { payload: { kind: 'command', run: ['true'] } }])
      assert.equal(
        normalizeAutomations([
          { id: 'review', schedule: 'every 1 hour', ...command, model: 'default' },
        ]).status,
        'invalid',
      );
    assert.throws(() => automationModels(jobs({ model: 'anthropic/model' }), undefined, 'codex'), {
      code: 'codex-model-provider-unsupported',
    });
  });
});
