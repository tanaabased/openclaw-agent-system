import assert from 'node:assert/strict';

import parse from '../manifest/parse.ts';
import { pickupDeclaration } from './issue-pickup-fixture.ts';
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
function builtinManifest(
  settings: Record<string, unknown> = {},
  configuredModels: unknown = models,
) {
  return parse(
    JSON.stringify({
      'schema-version': 1,
      agent: { id: 'receiver' },
      models: configuredModels,
      github: {
        username: 'receiver',
        routing: ['owner/*'],
        'issue-assignment': { allowed: ['@operator'], ...settings },
        'issue-pickup': { ...pickupDeclaration, ...settings },
      },
    }),
  );
}
describe('agent/automation-models', () => {
  it('should resolve conversation settings for reporting commands without changing command-only consumers', () => {
    const parsed = normalizeAutomations([
      {
        id: 'report',
        run: ['true'],
        schedule: 'every 1 hour',
        thread: { id: 'reports' },
        model: 'low',
        runtimes: ['openclaw'],
      },
      { id: 'silent', run: ['true'], schedule: 'every 1 hour' },
    ]);
    assert.equal(parsed.status, 'valid');
    if (parsed.status !== 'valid') return;
    const [report, silent] = automationModels(
      parsed.automations as ResolvedAutomation[],
      models,
      'openclaw',
    );
    assert.deepEqual(report!.overrides.openclaw, { model: 'openai/small', effort: 'high' });
    assert.deepEqual(silent, parsed.automations[1]);
    assert.equal(report!.payload.kind, 'command');
  });
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
      const unowned = jobs({ overrides: { [runtime]: { target: { thread: 'unowned' } } } });
      assert.deepEqual(automationModels(unowned, models, runtime), unowned);
      for (const settings of [
        { model: 'default' },
        { effort: 'low' },
        {
          overrides: { [runtime]: { target: { thread: 'unowned' }, effort: 'high' } },
        },
        {
          overrides: { [runtime]: { target: { thread: 'unowned' }, model: 'openai/explicit' } },
        },
      ])
        assert.throws(
          () =>
            automationModels(
              jobs({
                overrides: { [runtime]: { target: { thread: 'unowned' } } },
                ...settings,
              }),
              models,
              runtime,
            ),
          { code: 'automation-thread-settings-unowned' },
        );
      assert.equal(
        automationContent(automationModels(unowned, models, runtime)[0]!, runtime).hash,
        automationContent(
          automationModels(
            unowned,
            { default: { model: 'openai/changed', effort: 'high' } },
            runtime,
          )[0]!,
          runtime,
        ).hash,
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
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should resolve built-in defaults and explicit settings without changing issue routing in ${runtime}`, () => {
      const cases = [
        {
          settings: {},
          assignment: runtime === 'codex' ? 'openai/small' : 'openai/default',
          pickup: 'openai/default',
          assignmentEffort: runtime === 'codex' ? 'high' : 'medium',
          pickupEffort: 'medium',
        },
        {
          settings: { model: 'high' },
          assignment: 'openai/large',
          pickup: 'openai/large',
          assignmentEffort: 'xhigh',
          pickupEffort: 'xhigh',
        },
        {
          settings: { model: 'low', effort: 'minimal' },
          assignment: 'openai/small',
          pickup: 'openai/small',
          assignmentEffort: 'minimal',
          pickupEffort: 'minimal',
        },
        {
          settings: { model: 'openai/explicit' },
          assignment: 'openai/explicit',
          pickup: 'openai/explicit',
          assignmentEffort: 'medium',
          pickupEffort: 'medium',
        },
        {
          settings: { model: 'openai/explicit', effort: 'low' },
          assignment: 'openai/explicit',
          pickup: 'openai/explicit',
          assignmentEffort: 'low',
          pickupEffort: 'low',
        },
        {
          settings: { effort: 'low' },
          assignment: runtime === 'codex' ? 'openai/small' : 'openai/default',
          pickup: 'openai/default',
          assignmentEffort: 'low',
          pickupEffort: 'low',
        },
      ];
      for (const c of cases) {
        const result = builtinManifest(c.settings);
        assert.equal(result.status, 'valid', JSON.stringify(result));
        if (result.status !== 'valid') return;
        const before = structuredClone(result.manifest);
        const nativeJobs =
          runtime === 'codex'
            ? codexIntakeJobs(result.manifest)
            : openclawIntakeJobs(result.manifest);
        const native = (model: string) => (runtime === 'codex' ? model.slice(7) : model);
        assert.deepEqual(nativeJobs[0]!.overrides[runtime], {
          model: native(c.assignment),
          effort: c.assignmentEffort,
        });
        assert.deepEqual(nativeJobs[1]!.overrides[runtime], {
          model: native(c.pickup),
          effort: c.pickupEffort,
        });
        assert.deepEqual(result.manifest, before);
        assert.deepEqual(result.manifest.models, models);
      }
    });
    it(`should allow an explicit built-in selection without the unused low profile in ${runtime}`, () => {
      const parsed = builtinManifest(
        { model: 'openai/explicit', effort: 'low' },
        { default: models.default },
      );
      assert.equal(parsed.status, 'valid');
      if (parsed.status !== 'valid') return;
      const nativeJobs =
        runtime === 'codex'
          ? codexIntakeJobs(parsed.manifest)
          : openclawIntakeJobs(parsed.manifest);
      assert.equal(nativeJobs.length, 2);
      for (const job of nativeJobs) assert.equal(job.overrides[runtime]!.effort, 'low');
    });
  }
  it('should reject malformed built-in settings and missing selected profiles during manifest validation', () => {
    for (const settings of [
      { model: 'missing' },
      { model: 'openai/ bad' },
      { effort: 'unknown' },
      { profile: 'low' },
    ]) {
      const result = builtinManifest(settings);
      assert.equal(result.status, 'invalid', JSON.stringify(settings));
    }
    const missing = builtinManifest({ model: 'high' }, { default: models.default });
    assert.equal(missing.status, 'invalid');
    assert.deepEqual(
      missing.diagnostics.map((d) => [d.code, d.fieldPath]),
      [
        ['manifest-automation-profile-missing', '/github/issue-assignment/model'],
        ['manifest-automation-profile-missing', '/github/issue-pickup/model'],
      ],
    );
    const parsed = builtinManifest({ model: 'anthropic/unsupported' });
    assert.equal(parsed.status, 'valid');
    if (parsed.status !== 'valid') return;
    assert.throws(() => codexIntakeJobs(parsed.manifest), {
      code: 'codex-model-provider-unsupported',
    });
    parsed.manifest.github!.notifications!.issueAssignment!.model = 'default';
    assert.throws(() => codexIntakeJobs(parsed.manifest), {
      code: 'codex-model-provider-unsupported',
    });
    parsed.manifest.github!.notifications!.issuePickup!.model = 'default';
    parsed.manifest.github!.notifications!.issuePickup!.effort = 'adaptive';
    assert.throws(() => codexIntakeJobs(parsed.manifest), {
      code: 'codex-model-effort-unsupported',
    });
  });
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
