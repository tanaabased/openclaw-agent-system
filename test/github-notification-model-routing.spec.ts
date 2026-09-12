import assert from 'node:assert/strict';

import {
  initializeModelRouting,
  modelRoutingDecision,
  modelRoutingGuidance,
  validModelRouting,
} from '../channels/github/conversation/model-routing.ts';
import {
  nativeRoutingMetadata,
  routingMetadata,
} from '../channels/github/provider/routing-metadata.ts';
import type { GitHubNotificationItemContext } from '../channels/github/provider/work-event-types.ts';

const routingProfiles = {
  default: { model: 'openai/gpt-6-astra', effort: 'high' },
  low: { model: 'openai/gpt-5.6-terra', effort: 'medium' },
  medium: { model: 'openai/gpt-5.6-sol', effort: 'high' },
  high: { model: 'openai/gpt-6-astra', effort: 'high' },
} as const;

const context: GitHubNotificationItemContext = {
  title: 'Update the README',
  body: 'Fix a link.',
  comments: [],
  labels: [],
  truncated: false,
};

describe('channels/github/provider/routing-metadata', () => {
  it('should distinguish native values, duplicates, invalid values, conflicts, and unreadable pages', () => {
    const row = (value: unknown) => ({ issue_field_name: ' Complexity ', value });
    assert.deepEqual(nativeRoutingMetadata([row('Low'), row('low')]).complexity, {
      status: 'verified',
      value: 'low',
      source: 'native',
    });
    assert.equal(
      nativeRoutingMetadata([row('Low'), row('Medium')]).complexity.status,
      'conflicting',
    );
    assert.equal(nativeRoutingMetadata([row('Small')]).complexity.status, 'invalid');
    assert.equal(nativeRoutingMetadata([row(null)]).complexity.status, 'missing');
    assert.equal(nativeRoutingMetadata([]).complexity.status, 'missing');
    assert.equal(nativeRoutingMetadata([row('Low')], true).complexity.status, 'unavailable');
    assert.deepEqual(
      nativeRoutingMetadata([
        { field: { name: 'Work size' }, single_select_option: { name: '21' } },
      ]).workSize,
      { status: 'verified', value: 21, source: 'native' },
    );
  });

  it('should accept only a valid v2 fallback and retain native precedence', () => {
    const capsule =
      '```yaml\nschema: tanaab/task-metadata/v2\nmode: fallback\nfallback:\n  complexity: High\n  work-size: 3\n```';
    const missing = nativeRoutingMetadata([]);
    assert.equal(routingMetadata(missing, capsule).complexity.value, 'high');
    assert.equal(routingMetadata(missing, capsule).complexity.source, 'body fallback');
    const native = nativeRoutingMetadata([{ name: 'Complexity', value: 'Low' }]);
    assert.equal(routingMetadata(native, capsule).complexity.value, 'low');
    const invalid = nativeRoutingMetadata([{ name: 'Complexity', value: 'unknown' }]);
    assert.equal(routingMetadata(invalid, capsule).complexity.status, 'invalid');
    assert.equal(routingMetadata(missing, 'Complexity: High').complexity.status, 'missing');
    assert.equal(routingMetadata(missing, `<!--\n${capsule}\n-->`).complexity.status, 'missing');
    assert.equal(
      routingMetadata(missing, capsule.replace('/v2', '/v1')).complexity.status,
      'missing',
    );
    assert.equal(
      routingMetadata(
        missing,
        capsule.replace('complexity: High', 'complexity: High\n  complexity: Low'),
      ).complexity.status,
      'invalid',
    );
    assert.equal(
      routingMetadata(missing, `${capsule}\n${capsule.replace('High', 'Low')}`).complexity.status,
      'conflicting',
    );
  });
});

describe('channels/github/conversation/model-routing', () => {
  it('should leave default-only agents unchanged and freeze complete profiles', () => {
    assert.equal(initializeModelRouting(), undefined);
    assert.equal(initializeModelRouting({ default: routingProfiles.default }), undefined);
    const routing = initializeModelRouting(routingProfiles)!;
    routing.profiles.low.model = 'openai/changed';
    assert.equal(routingProfiles.low.model, 'openai/gpt-5.6-terra');
  });

  it('should use the model assessment without deriving a tier from work size', () => {
    const routing = initializeModelRouting(routingProfiles)!;
    const decision = modelRoutingDecision(
      '{"complexity":"low","reason":"Established documentation change."}',
      routing,
      {
        ...context,
        routingMetadata: nativeRoutingMetadata([{ name: 'Work size', value: 21 }]),
      },
    );
    assert.equal(decision.model, routingProfiles.low.model);
    assert.equal(decision.source, 'assessed');
    routing.decision = decision;
    assert.ok(validModelRouting(routing));
    assert.match(modelRoutingGuidance(routing), /Model routing/);
    assert.match(modelRoutingGuidance(routing), /not proof of effective runtime/);
  });

  it('should reject invented profiles, malformed output, unset tiers and contradictions of native complexity', () => {
    const routing = initializeModelRouting(routingProfiles)!;
    for (const text of [
      'not json',
      '{"complexity":"unset","reason":"Unclear."}',
      '{"complexity":"low","reason":"fine","model":"other"}',
    ]) {
      assert.throws(() => modelRoutingDecision(text, routing, context));
    }
    assert.throws(
      () =>
        modelRoutingDecision('{"complexity":"low","reason":"small"}', routing, {
          ...context,
          routingMetadata: nativeRoutingMetadata([{ name: 'Complexity', value: 'High' }]),
        }),
      /contradicted verified Complexity/,
    );
  });

  it('should require a concrete xhigh reason and reject corrupted persisted selections', () => {
    const routing = initializeModelRouting(routingProfiles)!;
    routing.profiles.high.effort = 'xhigh';
    assert.throws(
      () =>
        modelRoutingDecision('{"complexity":"high","reason":"Architectural."}', routing, context),
      /justification/,
    );
    routing.decision = modelRoutingDecision(
      '{"complexity":"high","reason":"Architectural.","xhighReason":"Requires reconciling several competing concurrency invariants."}',
      routing,
      context,
    );
    assert.ok(validModelRouting(routing));
    assert.equal(
      validModelRouting({
        ...routing,
        decision: { ...routing.decision, model: routingProfiles.low.model },
      }),
      false,
    );
  });

  it('should distinguish verified, continued, and unverified execution records', () => {
    const routing = initializeModelRouting(routingProfiles)!;
    routing.decision = modelRoutingDecision(
      '{"complexity":"low","reason":"Localized change."}',
      routing,
      context,
    );
    routing.applied = routingProfiles.low;
    for (const execution of [
      {
        requested: routingProfiles.low,
        observed: routingProfiles.low,
        status: 'verified',
      },
      {
        requested: routingProfiles.low,
        observed: routingProfiles.default,
        status: 'continued',
      },
      {
        requested: routingProfiles.low,
        observed: { model: routingProfiles.default.model },
        status: 'unverified',
      },
    ] as const) {
      assert.ok(validModelRouting({ ...routing, execution }));
    }
    assert.equal(
      validModelRouting({
        ...routing,
        execution: {
          requested: routingProfiles.low,
          observed: routingProfiles.default,
          status: 'verified',
        },
      }),
      false,
    );
  });
});
