import assert from 'node:assert/strict';

import {
  nativeRoutingMetadata,
  routingMetadata,
} from '../channels/github/provider/routing-metadata.ts';

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
