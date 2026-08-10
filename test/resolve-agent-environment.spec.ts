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
            overriddenSources: [],
            required: true,
            source: 'environment.set',
          },
          {
            name: 'GITHUB_TOKEN',
            overriddenSources: [],
            required: false,
            source: 'environment.set',
          },
          {
            name: 'ZEBRA',
            overriddenSources: [],
            required: false,
            source: 'environment.set',
          },
        ],
      },
    });
  });

  it('should merge ordered dotenv sources before environment.set and retain provenance', () => {
    const resolved = resolveAgentEnvironment(
      {
        schemaVersion: 1,
        agent: { id: 'data' },
        environment: {
          required: ['DOTENV_ONLY'],
          set: {
            FROM_DOTENV: '$DOTENV_REFERENCE',
            LAYERED: 'set-value',
          },
        },
      },
      { DOTENV_REFERENCE: 'host-value', HOST_ONLY: 'not-exported' },
      {
        dotenv: [
          {
            source: 'environment.dotenv[0]',
            values: {
              DOTENV_ONLY: 'base-required-value',
              DOTENV_REFERENCE: 'base-reference',
              LAYERED: 'base-value',
            },
          },
          {
            source: 'environment.dotenv[1]',
            values: { DOTENV_REFERENCE: 'override-reference', LAYERED: 'override-value' },
          },
        ],
      },
    );

    assert.deepEqual(resolved, {
      status: 'resolved',
      environment: {
        values: {
          DOTENV_ONLY: 'base-required-value',
          DOTENV_REFERENCE: 'override-reference',
          LAYERED: 'set-value',
          FROM_DOTENV: 'override-reference',
        },
        variables: [
          {
            name: 'DOTENV_ONLY',
            overriddenSources: [],
            required: true,
            source: 'environment.dotenv[0]',
          },
          {
            name: 'DOTENV_REFERENCE',
            overriddenSources: ['environment.dotenv[0]'],
            required: false,
            source: 'environment.dotenv[1]',
          },
          {
            name: 'FROM_DOTENV',
            overriddenSources: [],
            required: false,
            source: 'environment.set',
          },
          {
            name: 'LAYERED',
            overriddenSources: ['environment.dotenv[0]', 'environment.dotenv[1]'],
            required: false,
            source: 'environment.set',
          },
        ],
      },
    });
  });

  it('should merge 1password after environment.set and preserve masked interpolation', () => {
    const resolved = resolveAgentEnvironment(
      {
        schemaVersion: 1,
        agent: { id: 'data' },
        environment: {
          op: ['env-team', 'env-agent'],
          set: {
            FROM_ONEPASSWORD: '$ONEPASSWORD_REFERENCE',
            LAYERED: 'set-value',
          },
        },
      },
      {},
      {
        dotenv: [
          {
            source: 'environment.dotenv[0]',
            values: { LAYERED: 'dotenv-value' },
          },
        ],
        op: [
          {
            source: 'environment.op[0]',
            sensitiveNames: ['ONEPASSWORD_REFERENCE'],
            values: {
              LAYERED: 'team-value',
              ONEPASSWORD_REFERENCE: 'masked-reference',
            },
          },
          {
            source: 'environment.op[1]',
            sensitiveNames: ['MASKED_FINAL'],
            values: { LAYERED: 'agent-value', MASKED_FINAL: 'masked-final' },
          },
        ],
      },
    );

    assert.deepEqual(resolved, {
      status: 'resolved',
      environment: {
        sensitiveNames: ['FROM_ONEPASSWORD', 'MASKED_FINAL', 'ONEPASSWORD_REFERENCE'],
        values: {
          LAYERED: 'agent-value',
          FROM_ONEPASSWORD: 'masked-reference',
          ONEPASSWORD_REFERENCE: 'masked-reference',
          MASKED_FINAL: 'masked-final',
        },
        variables: [
          {
            name: 'FROM_ONEPASSWORD',
            overriddenSources: [],
            required: false,
            source: 'environment.set',
          },
          {
            name: 'LAYERED',
            overriddenSources: ['environment.dotenv[0]', 'environment.set', 'environment.op[0]'],
            required: false,
            source: 'environment.op[1]',
          },
          {
            name: 'MASKED_FINAL',
            overriddenSources: [],
            required: false,
            source: 'environment.op[1]',
          },
          {
            name: 'ONEPASSWORD_REFERENCE',
            overriddenSources: [],
            required: false,
            source: 'environment.op[0]',
          },
        ],
      },
    });
  });

  it('should resolve direct op secrets as sensitive environment.set values', () => {
    const resolved = resolveAgentEnvironment(
      {
        schemaVersion: 1,
        agent: { id: 'data' },
        environment: {
          required: ['SSH_KEY'],
          set: { SSH_KEY: { fromOp: 'op://vault/item/private key' } },
        },
      },
      {},
      {
        set: {
          sensitiveNames: ['SSH_KEY'],
          values: { SSH_KEY: 'private-key-value' },
        },
      },
    );

    assert.deepEqual(resolved, {
      status: 'resolved',
      environment: {
        sensitiveNames: ['SSH_KEY'],
        values: { SSH_KEY: 'private-key-value' },
        variables: [
          {
            name: 'SSH_KEY',
            overriddenSources: [],
            required: true,
            source: 'environment.set',
          },
        ],
      },
    });
  });

  it('should reject unresolved direct op secrets without exposing references', () => {
    const reference = 'op://private-vault/private-item/private-field';
    const resolved = resolveAgentEnvironment(
      {
        schemaVersion: 1,
        agent: { id: 'data' },
        environment: { set: { SSH_KEY: { fromOp: reference } } },
      },
      {},
    );

    assert.equal(resolved.status, 'invalid');
    if (resolved.status !== 'invalid') return;
    assert.equal(resolved.diagnostics[0]?.code, 'op-secret-unavailable');
    assert.equal(JSON.stringify(resolved.diagnostics).includes(reference), false);
  });

  it('should reject every attempt to export the 1password bootstrap token', () => {
    const privateToken = 'private-bootstrap-token';
    const resolved = resolveAgentEnvironment(
      {
        schemaVersion: 1,
        agent: { id: 'data' },
        environment: {
          required: ['OP_SERVICE_ACCOUNT_TOKEN'],
          set: {
            ALIAS: '$OP_SERVICE_ACCOUNT_TOKEN',
            OP_SERVICE_ACCOUNT_TOKEN: { fromOp: 'op://private-vault/private-item/private-field' },
          },
        },
      },
      { OP_SERVICE_ACCOUNT_TOKEN: privateToken },
      {
        dotenv: [
          {
            source: 'environment.dotenv[0]',
            values: { OP_SERVICE_ACCOUNT_TOKEN: 'dotenv-token' },
          },
        ],
      },
    );

    assert.equal(resolved.status, 'invalid');
    if (resolved.status !== 'invalid') return;
    assert.deepEqual(
      resolved.diagnostics.map(({ code }) => code),
      [
        'environment-reserved-variable',
        'environment-reserved-reference',
        'environment-reserved-variable',
        'environment-reserved-variable',
      ],
    );
    assert.equal(JSON.stringify(resolved.diagnostics).includes(privateToken), false);
    assert.equal(JSON.stringify(resolved.diagnostics).includes('private-vault'), false);
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
