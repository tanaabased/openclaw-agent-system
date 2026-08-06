import assert from 'node:assert/strict';

import OnePasswordEnvironmentService from '../lib/onepassword-environment-service.ts';

describe('lib/onepassword-environment-service', () => {
  it('should remain lazy when no 1password environments are declared', async () => {
    let credentialCalls = 0;
    let clientCalls = 0;
    const service = new OnePasswordEnvironmentService({
      createClient: async () => {
        clientCalls += 1;
        throw new Error('not expected');
      },
      credentialService: {
        async resolveServiceAccountToken() {
          credentialCalls += 1;
          return 'private-token';
        },
      },
      integrationVersion: 'test',
    });

    assert.deepEqual(await service.load('data', []), { status: 'loaded', sources: [] });
    assert.equal(credentialCalls, 0);
    assert.equal(clientCalls, 0);
  });

  it('should report a value-free diagnostic when no credential is available', async () => {
    const service = new OnePasswordEnvironmentService({
      credentialService: {
        async resolveServiceAccountToken() {
          return undefined;
        },
      },
      integrationVersion: 'test',
    });

    assert.deepEqual(await service.load('data', ['private-environment-id']), {
      status: 'invalid',
      diagnostics: [
        {
          code: 'onepassword-credential-missing',
          fieldPath: '/environment/onepassword-environments',
          message:
            '1Password Environment resolution requires an available service-account credential.',
          severity: 'error',
        },
      ],
    });
  });

  it('should hide credential-provider failures', async () => {
    const service = new OnePasswordEnvironmentService({
      credentialService: {
        async resolveServiceAccountToken() {
          throw new Error('private-provider-error');
        },
      },
      integrationVersion: 'test',
    });

    const result = await service.load('data', ['private-environment-id']);

    assert.equal(result.status, 'invalid');
    assert.equal(JSON.stringify(result).includes('private-provider-error'), false);
    assert.equal(JSON.stringify(result).includes('private-environment-id'), false);
  });

  it('should load ordered sources through one authenticated sdk client', async () => {
    const clientInputs: Array<{ integrationVersion: string; token: string }> = [];
    const environmentCalls: string[] = [];
    const service = new OnePasswordEnvironmentService({
      createClient: async (token, integrationVersion) => {
        clientInputs.push({ integrationVersion, token });
        return {
          async getVariables(environmentId) {
            environmentCalls.push(environmentId);
            return {
              variables:
                environmentId === 'env-team'
                  ? [
                      { masked: false, name: 'PUBLIC_VALUE', value: 'team-public' },
                      { masked: true, name: 'PRIVATE_VALUE', value: 'team-private' },
                    ]
                  : [{ masked: true, name: 'PRIVATE_VALUE', value: 'agent-private' }],
            };
          },
        };
      },
      credentialService: {
        async resolveServiceAccountToken(agentId) {
          assert.equal(agentId, 'data');
          return 'private-token';
        },
      },
      integrationVersion: '1.2.3',
    });

    assert.deepEqual(await service.load('data', ['env-team', 'env-agent']), {
      status: 'loaded',
      sources: [
        {
          source: 'environment.onepassword-environments[0]',
          sensitiveNames: ['PRIVATE_VALUE'],
          values: { PUBLIC_VALUE: 'team-public', PRIVATE_VALUE: 'team-private' },
        },
        {
          source: 'environment.onepassword-environments[1]',
          sensitiveNames: ['PRIVATE_VALUE'],
          values: { PRIVATE_VALUE: 'agent-private' },
        },
      ],
    });
    assert.deepEqual(clientInputs, [{ integrationVersion: '1.2.3', token: 'private-token' }]);
    assert.deepEqual(environmentCalls, ['env-team', 'env-agent']);
  });

  it('should hide sdk errors and environment ids from failure diagnostics', async () => {
    const service = new OnePasswordEnvironmentService({
      createClient: async () => ({
        async getVariables() {
          throw new Error('private-sdk-response');
        },
      }),
      credentialService: {
        async resolveServiceAccountToken() {
          return 'private-token';
        },
      },
      integrationVersion: 'test',
    });

    const result = await service.load('data', ['private-environment-id']);

    assert.equal(result.status, 'invalid');
    assert.equal(JSON.stringify(result).includes('private-sdk-response'), false);
    assert.equal(JSON.stringify(result).includes('private-environment-id'), false);
  });

  it('should reject invalid and duplicate variable names without exposing values', async () => {
    for (const variables of [
      [{ masked: true, name: 'not-valid', value: 'private-value' }],
      [
        { masked: true, name: 'DUPLICATE', value: 'private-one' },
        { masked: false, name: 'DUPLICATE', value: 'private-two' },
      ],
    ]) {
      const service = new OnePasswordEnvironmentService({
        createClient: async () => ({
          async getVariables() {
            return { variables };
          },
        }),
        credentialService: {
          async resolveServiceAccountToken() {
            return 'private-token';
          },
        },
        integrationVersion: 'test',
      });

      const result = await service.load('data', ['environment-id']);
      assert.equal(result.status, 'invalid');
      assert.equal(JSON.stringify(result).includes('private-'), false);
    }
  });
});
