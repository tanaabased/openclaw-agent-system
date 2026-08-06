import assert from 'node:assert/strict';

import resolveAgentEnvironment from '../utils/resolve-agent-environment.ts';

describe('utils/resolve-agent-environment', () => {
  it('should separate sorted metadata from resolved values', () => {
    const resolved = resolveAgentEnvironment(
      {
        schemaVersion: 1,
        agent: { id: 'data' },
        environment: {
          required: ['ALPHA'],
          set: {
            ZEBRA: '$ANIMAL',
            GITHUB_TOKEN: '${HOST_GITHUB_TOKEN}',
            ALPHA: 'first-value',
          },
        },
      },
      {
        ANIMAL: 'last-value',
        HOST_GITHUB_TOKEN: 'protected-value',
      },
    );

    assert.deepEqual(resolved, {
      status: 'resolved',
      environment: {
        values: {
          ZEBRA: 'last-value',
          GITHUB_TOKEN: 'protected-value',
          ALPHA: 'first-value',
        },
        variables: [
          {
            name: 'ALPHA',
            required: true,
            source: 'environment.set',
          },
          {
            name: 'GITHUB_TOKEN',
            required: false,
            source: 'environment.set',
          },
          {
            name: 'ZEBRA',
            required: false,
            source: 'environment.set',
          },
        ],
      },
    });
  });

  it('should resolve a manifest without environment data to empty collections', () => {
    assert.deepEqual(resolveAgentEnvironment({ schemaVersion: 1, agent: { id: 'data' } }, {}), {
      status: 'resolved',
      environment: { values: {}, variables: [] },
    });
  });

  it('should reject missing references and missing or empty required values', () => {
    const resolved = resolveAgentEnvironment(
      {
        schemaVersion: 1,
        agent: { id: 'data' },
        environment: {
          required: ['EMPTY_VALUE', 'NOT_DECLARED'],
          set: {
            EMPTY_VALUE: '$EMPTY_SOURCE',
            REFERENCED_VALUE: '$MISSING_SOURCE',
          },
        },
      },
      { EMPTY_SOURCE: '' },
    );

    assert.equal(resolved.status, 'invalid');
    if (resolved.status !== 'invalid') return;
    assert.deepEqual(
      resolved.diagnostics.map(({ code, fieldPath }) => ({ code, fieldPath })),
      [
        {
          code: 'environment-reference-missing',
          fieldPath: '/environment/set/REFERENCED_VALUE',
        },
        { code: 'environment-required-missing', fieldPath: '/environment/required' },
        { code: 'environment-required-missing', fieldPath: '/environment/required' },
      ],
    );
    assert.equal(
      resolved.diagnostics.some(({ message }) => message.includes('MISSING_SOURCE')),
      true,
    );
    assert.equal(
      resolved.diagnostics.some(({ message }) => message.includes('EMPTY_SOURCE')),
      false,
    );
  });

  it('should not resolve one environment.set value from another', () => {
    const resolved = resolveAgentEnvironment(
      {
        schemaVersion: 1,
        agent: { id: 'data' },
        environment: { set: { BASE: 'one', DERIVED: '$BASE' } },
      },
      {},
    );

    assert.equal(resolved.status, 'invalid');
    if (resolved.status !== 'invalid') return;
    assert.equal(resolved.diagnostics[0]?.code, 'environment-reference-missing');
  });
});
