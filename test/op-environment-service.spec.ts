import assert from 'node:assert/strict';

import OpEnvironmentService from '../environment/op-service.ts';

describe('environment/op-service', () => {
  it('should remain lazy when no op resources are declared', async () => {
    let credentialCalls = 0;
    let clientCalls = 0;
    const service = new OpEnvironmentService({
      createClient: async () => {
        clientCalls += 1;
        throw new Error('not expected');
      },
      credentialService: {
        async resolveServiceAccountToken() {
          credentialCalls += 1;
          return {
            status: 'resolved',
            source: { id: 'process-environment', type: 'environment' },
            token: 'private-token',
          } as const;
        },
      },
      integrationVersion: 'test',
    });

    assert.deepEqual(await service.load('data', { environmentIds: [], secrets: [] }), {
      status: 'loaded',
      set: { sensitiveNames: [], values: {} },
      sources: [],
    });
    assert.equal(credentialCalls, 0);
    assert.equal(clientCalls, 0);
  });

  it('should report a value-free diagnostic when no credential is available', async () => {
    const service = new OpEnvironmentService({
      credentialService: {
        async resolveServiceAccountToken() {
          return { status: 'missing' } as const;
        },
      },
      integrationVersion: 'test',
    });

    assert.deepEqual(
      await service.load('data', { environmentIds: ['private-environment-id'], secrets: [] }),
      {
        status: 'invalid',
        diagnostics: [
          {
            code: 'op-credential-missing',
            fieldPath: '/environment',
            message: 'OP resource resolution requires an available service-account credential.',
            severity: 'error',
          },
        ],
      },
    );
  });

  it('should hide credential-provider failures', async () => {
    const service = new OpEnvironmentService({
      credentialService: {
        async resolveServiceAccountToken() {
          throw new Error('private-provider-error');
        },
      },
      integrationVersion: 'test',
    });

    const result = await service.load('data', {
      environmentIds: ['private-environment-id'],
      secrets: [],
    });

    assert.equal(result.status, 'invalid');
    assert.equal(JSON.stringify(result).includes('private-provider-error'), false);
    assert.equal(JSON.stringify(result).includes('private-environment-id'), false);
  });

  it('should load ordered sources through one authenticated sdk client', async () => {
    const clientInputs: Array<{ integrationVersion: string; token: string }> = [];
    const environmentCalls: string[] = [];
    const service = new OpEnvironmentService({
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
          async resolveSecret() {
            throw new Error('not expected');
          },
        };
      },
      credentialService: {
        async resolveServiceAccountToken(agentId) {
          assert.equal(agentId, 'data');
          return {
            status: 'resolved',
            source: { id: 'file', type: 'store' },
            token: 'private-token',
          } as const;
        },
      },
      integrationVersion: '1.2.3',
    });

    assert.deepEqual(
      await service.load('data', { environmentIds: ['env-team', 'env-agent'], secrets: [] }),
      {
        status: 'loaded',
        set: { sensitiveNames: [], values: {} },
        sources: [
          {
            source: 'environment.op[0]',
            sensitiveNames: ['PRIVATE_VALUE'],
            values: { PUBLIC_VALUE: 'team-public', PRIVATE_VALUE: 'team-private' },
          },
          {
            source: 'environment.op[1]',
            sensitiveNames: ['PRIVATE_VALUE'],
            values: { PRIVATE_VALUE: 'agent-private' },
          },
        ],
      },
    );
    assert.deepEqual(clientInputs, [{ integrationVersion: '1.2.3', token: 'private-token' }]);
    assert.deepEqual(environmentCalls, ['env-team', 'env-agent']);
  });

  it('should hide sdk errors and environment ids from failure diagnostics', async () => {
    const service = new OpEnvironmentService({
      createClient: async () => ({
        async getVariables() {
          throw new Error('private-sdk-response');
        },
        async resolveSecret() {
          throw new Error('not expected');
        },
      }),
      credentialService: {
        async resolveServiceAccountToken() {
          return {
            status: 'resolved',
            source: { id: 'file', type: 'store' },
            token: 'private-token',
          } as const;
        },
      },
      integrationVersion: 'test',
    });

    const result = await service.load('data', {
      environmentIds: ['private-environment-id'],
      secrets: [],
    });

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
      const service = new OpEnvironmentService({
        createClient: async () => ({
          async getVariables() {
            return { variables };
          },
          async resolveSecret() {
            throw new Error('not expected');
          },
        }),
        credentialService: {
          async resolveServiceAccountToken() {
            return {
              status: 'resolved',
              source: { id: 'file', type: 'store' },
              token: 'private-token',
            } as const;
          },
        },
        integrationVersion: 'test',
      });

      const result = await service.load('data', {
        environmentIds: ['environment-id'],
        secrets: [],
      });
      assert.equal(result.status, 'invalid');
      assert.equal(JSON.stringify(result).includes('private-'), false);
    }
  });

  it('should validate every declared environment without returning values or ids', async () => {
    const calls: string[] = [];
    const service = new OpEnvironmentService({
      createClient: async () => ({
        async getVariables(environmentId) {
          calls.push(environmentId);
          return { variables: [{ masked: true, name: 'SECRET', value: 'private-value' }] };
        },
        async resolveSecret() {
          throw new Error('not expected');
        },
      }),
      credentialService: {
        async resolveServiceAccountToken(agentId, options) {
          assert.equal(agentId, 'data');
          assert.deepEqual(options, { storeId: 'file', allowEnvironmentFallback: false });
          return {
            status: 'resolved',
            source: { id: 'file', type: 'store' },
            token: 'private-token',
          } as const;
        },
      },
      integrationVersion: 'test',
    });

    assert.deepEqual(
      await service.validate(
        'data',
        { environmentIds: ['private-one', 'private-two'], secrets: [] },
        {
          storeId: 'file',
          allowEnvironmentFallback: false,
        },
      ),
      {
        status: 'valid',
        environmentCount: 2,
        secretCount: 0,
        source: { id: 'file', type: 'store' },
      },
    );
    assert.deepEqual(calls, ['private-one', 'private-two']);
  });

  it('should validate a candidate token before storage', async () => {
    const tokens: string[] = [];
    const service = new OpEnvironmentService({
      createClient: async (token) => {
        tokens.push(token);
        return {
          async getVariables() {
            return { variables: [] };
          },
          async resolveSecret() {
            throw new Error('not expected');
          },
        };
      },
      credentialService: {
        async resolveServiceAccountToken() {
          return { status: 'missing' } as const;
        },
      },
      integrationVersion: 'test',
    });

    assert.deepEqual(
      await service.validateToken('private-candidate', {
        environmentIds: ['private-id'],
        secrets: [],
      }),
      {
        status: 'valid',
        environmentCount: 1,
        secretCount: 0,
      },
    );
    assert.deepEqual(tokens, ['private-candidate']);
  });

  it('should resolve direct secrets and environments through one authenticated sdk client', async () => {
    let clientCalls = 0;
    const calls: string[] = [];
    const service = new OpEnvironmentService({
      createClient: async () => {
        clientCalls += 1;
        return {
          async getVariables(environmentId) {
            calls.push(`environment:${environmentId}`);
            return { variables: [{ masked: false, name: 'PUBLIC', value: 'public-value' }] };
          },
          async resolveSecret(reference) {
            calls.push(`secret:${reference}`);
            return 'private-secret';
          },
        };
      },
      credentialService: {
        async resolveServiceAccountToken() {
          return {
            status: 'resolved',
            source: { id: 'file', type: 'store' },
            token: 'private-token',
          } as const;
        },
      },
      integrationVersion: 'test',
    });

    assert.deepEqual(
      await service.load('data', {
        environmentIds: ['env-id'],
        secrets: [{ name: 'SSH_KEY', reference: 'op://vault/item/private key' }],
      }),
      {
        status: 'loaded',
        set: { sensitiveNames: ['SSH_KEY'], values: { SSH_KEY: 'private-secret' } },
        sources: [
          {
            source: 'environment.op[0]',
            sensitiveNames: [],
            values: { PUBLIC: 'public-value' },
          },
        ],
      },
    );
    assert.equal(clientCalls, 1);
    assert.deepEqual(calls, ['secret:op://vault/item/private key', 'environment:env-id']);
  });

  it('should hide direct secret references and sdk errors from failure diagnostics', async () => {
    const service = new OpEnvironmentService({
      createClient: async () => ({
        async getVariables() {
          throw new Error('not expected');
        },
        async resolveSecret() {
          throw new Error('private-sdk-error');
        },
      }),
      credentialService: {
        async resolveServiceAccountToken() {
          return {
            status: 'resolved',
            source: { id: 'file', type: 'store' },
            token: 'private-token',
          } as const;
        },
      },
      integrationVersion: 'test',
    });

    const result = await service.load('data', {
      environmentIds: [],
      secrets: [{ name: 'SSH_KEY', reference: 'op://private-vault/private-item/private-field' }],
    });

    assert.equal(result.status, 'invalid');
    assert.equal(JSON.stringify(result).includes('private-sdk-error'), false);
    assert.equal(JSON.stringify(result).includes('private-vault'), false);
    assert.equal(JSON.stringify(result).includes('SSH_KEY'), true);
  });
});
