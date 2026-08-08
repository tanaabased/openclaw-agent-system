import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import {
  externalEnvironmentBindingSchema,
  externalResolvableStringSchema,
} from '../utils/manifest-value-schemas.ts';

describe('utils/manifest-value-schemas', () => {
  it('should allow literal or explicit environment-backed resolvable strings', () => {
    assert.equal(Value.Check(externalResolvableStringSchema, 'Tanaabot'), true);
    assert.equal(
      Value.Check(externalResolvableStringSchema, { 'from-environment': 'AGENT_NAME' }),
      true,
    );
    assert.equal(Value.Check(externalResolvableStringSchema, { environment: 'AGENT_NAME' }), false);
  });

  it('should treat uppercase scalar names as environment-only bindings', () => {
    assert.equal(Value.Check(externalEnvironmentBindingSchema, 'GITHUB_TOKEN'), true);
    assert.equal(Value.Check(externalEnvironmentBindingSchema, 'github-token-value'), false);
    assert.equal(Value.Check(externalEnvironmentBindingSchema, 'github_token'), false);
  });
});
