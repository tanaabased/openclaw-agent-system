import assert from 'node:assert/strict';

import { inspectModelRouting, resolveModelRouting, RoutingError } from '../agent/model-routing.ts';
import resolveModelRoutingRequest from '../agent/model-routing-request.ts';
import type { AgentModelsConfiguration } from '../manifest/models-schema.ts';

const profiles: AgentModelsConfiguration = {
  default: { model: 'openai/default', effort: 'medium' },
  low: { model: 'openai/small', effort: 'high' },
  medium: { model: 'openai/middle', effort: 'medium' },
  high: { model: 'anthropic/large', effort: 'high' },
};
const assessment = { complexity: 'low' as const, reason: 'One established local change.' };
const unresolved = { complexity: 'unset' as const, reason: 'The task has no actionable scope.' };
const request = {
  action: 'resolve',
  manifestDigest: 'digest',
  context: 'Bounded task evidence.',
  assessment,
};

function code(expected: string) {
  return (error: unknown) => error instanceof RoutingError && error.code === expected;
}

describe('shared model routing', () => {
  it('should use declared efforts rather than infer effort from complexity', () => {
    for (const complexity of ['low', 'medium', 'high'] as const) {
      const result = resolveModelRouting(profiles, { ...assessment, complexity });
      assert.deepEqual(result.selection, profiles[complexity]);
      assert.equal(result.profile, complexity);
      assert.equal(result.source, 'assessed');
    }
    const inspected = inspectModelRouting(profiles, 'codex');
    assert.equal(inspected.status, 'available');
    if (inspected.status === 'available') {
      assert.deepEqual(inspected.profiles.default, {
        status: 'mapped',
        sourceModel: 'openai/default',
        model: 'default',
        thinking: 'medium',
      });
      assert.equal(inspected.profiles.high?.status, 'unsupported');
    }
  });

  it('should preserve independent explicit overrides and translate native codex model ids', () => {
    for (const overrides of [
      { model: 'explicit' },
      { effort: 'low' },
      { model: 'explicit', effort: 'high' },
    ]) {
      const result = resolveModelRoutingRequest(
        profiles,
        'digest',
        { ...request, overrides },
        'codex',
      );
      assert.ok('selection' in result);
      assert.deepEqual(result.selection, {
        model: overrides.model ? 'openai/explicit' : 'openai/small',
        effort: overrides.effort ?? 'high',
      });
      assert.equal(result.application, 'not-requested');
      assert.equal(result.execution, 'unverified');
    }
  });

  it('should return unresolved without a hidden default and permit an explicit default policy', () => {
    const result = resolveModelRouting(profiles, unresolved);
    assert.equal(result.status, 'unresolved');
    assert.equal(result.reason, unresolved.reason);
    assert.equal(result.profile, null);
    assert.equal(result.selection, undefined);
    const fallback = resolveModelRouting(profiles, unresolved, {
      fallback: 'default',
      evidence: { complexity: 'low', source: 'native' },
    });
    assert.equal(fallback.status, 'unresolved');
    assert.equal(fallback.profile, 'default');
    assert.deepEqual(fallback.selection, profiles.default);
    const manual = resolveModelRouting(profiles, unresolved, {
      overrides: { model: 'openai/manual', effort: 'low' },
    });
    assert.deepEqual(manual.selection, { model: 'openai/manual', effort: 'low' });
  });

  it('should distinguish missing profiles, invalid profiles, and unsupported selections', () => {
    assert.equal(inspectModelRouting(undefined, 'codex').status, 'unavailable');
    assert.equal(inspectModelRouting({ default: profiles.default }, 'codex').status, 'available');
    assert.equal(
      resolveModelRouting({ default: profiles.default }, assessment, { fallback: 'default' })
        .profile,
      'default',
    );
    assert.throws(
      () => resolveModelRouting({ default: profiles.default }, assessment),
      code('model-routing-profile-missing'),
    );
    assert.throws(
      () => inspectModelRouting({ default: profiles.default, low: profiles.low }, 'codex'),
      code('model-routing-profiles-invalid'),
    );
    assert.throws(
      () =>
        resolveModelRoutingRequest(
          profiles,
          'digest',
          { ...request, assessment: { ...assessment, complexity: 'high' } },
          'codex',
        ),
      code('codex-model-provider-unsupported'),
    );
    assert.throws(
      () =>
        resolveModelRoutingRequest(
          profiles,
          'digest',
          { ...request, overrides: { effort: 'banana' } },
          'codex',
        ),
      code('model-routing-selection-unsupported'),
    );
    assert.throws(
      () =>
        resolveModelRoutingRequest(
          profiles,
          'digest',
          { ...request, overrides: { effort: 'off' } },
          'codex',
        ),
      code('codex-model-effort-unsupported'),
    );
  });

  it('should reject unsupported partial overrides even while complexity is unresolved', () => {
    const input = { ...request, assessment: unresolved };
    assert.throws(
      () =>
        resolveModelRoutingRequest(
          profiles,
          'digest',
          { ...input, overrides: { model: 'anthropic/other' } },
          'codex',
        ),
      code('codex-model-provider-unsupported'),
    );
    assert.throws(
      () =>
        resolveModelRoutingRequest(
          profiles,
          'digest',
          { ...input, overrides: { effort: 'banana' } },
          'codex',
        ),
      code('model-routing-selection-unsupported'),
    );
    assert.throws(
      () =>
        resolveModelRoutingRequest(
          profiles,
          'digest',
          { ...input, overrides: { effort: 'xhigh' } },
          'codex',
        ),
      code('model-routing-xhigh-unjustified'),
    );
  });

  it('should retain openclaw adaptive overrides without projecting them into codex', () => {
    const input = { ...request, overrides: { effort: 'adaptive' } };
    const result = resolveModelRoutingRequest(profiles, 'digest', input, 'openclaw');
    assert.ok('selection' in result);
    assert.equal(result.selection?.effort, 'adaptive');
    assert.throws(
      () => resolveModelRoutingRequest(profiles, 'digest', input, 'codex'),
      code('codex-model-effort-unsupported'),
    );
  });

  it('should require justification for selected, explicit, and classifier xhigh', () => {
    const xhigh = { ...profiles, low: { ...profiles.low!, effort: 'xhigh' as const } };
    for (const [models, options] of [
      [xhigh, {}],
      [profiles, { overrides: { effort: 'xhigh' } }],
      [profiles, { classifierEffort: 'xhigh' }],
    ] as const) {
      assert.throws(
        () => resolveModelRouting(models, assessment, options),
        code('model-routing-xhigh-unjustified'),
      );
      assert.equal(
        resolveModelRouting(
          models,
          { ...assessment, xhighReason: 'Reconcile competing concurrency invariants.' },
          options,
        ).status,
        'resolved',
      );
    }
  });

  it('should reject stale profiles, oversized context, and conflicting evidence', () => {
    assert.throws(
      () => resolveModelRoutingRequest(profiles, 'changed', request, 'codex'),
      code('model-routing-manifest-changed'),
    );
    assert.throws(
      () =>
        resolveModelRoutingRequest(
          profiles,
          'digest',
          { ...request, context: 'x'.repeat(18001) },
          'codex',
        ),
      code('model-routing-request-invalid'),
    );
    assert.throws(
      () =>
        resolveModelRoutingRequest(
          profiles,
          'digest',
          { ...request, workspace: '/other' },
          'codex',
        ),
      code('model-routing-request-invalid'),
    );
    assert.throws(
      () =>
        resolveModelRouting(profiles, assessment, {
          evidence: { complexity: 'high', source: 'native' },
        }),
      code('model-routing-metadata-conflict'),
    );
    assert.equal(
      resolveModelRouting(profiles, assessment, { evidence: { complexity: 'low', source: 'user' } })
        .source,
      'user',
    );
  });
});
