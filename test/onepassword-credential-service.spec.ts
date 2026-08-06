import assert from 'node:assert/strict';

import OnePasswordCredentialService from '../lib/onepassword-credential-service.ts';

describe('lib/onepassword-credential-service', () => {
  it('should prefer configured providers before the process-environment fallback', async () => {
    const calls: string[] = [];
    const service = new OnePasswordCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' },
      providers: [
        {
          async resolveServiceAccountToken(agentId) {
            calls.push(agentId);
            return 'provider-token';
          },
        },
      ],
    });

    assert.equal(await service.resolveServiceAccountToken('data'), 'provider-token');
    assert.deepEqual(calls, ['data']);
  });

  it('should permanently support a fixed process-environment fallback', async () => {
    const hostEnvironment = { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' };
    const service = new OnePasswordCredentialService({
      hostEnvironment,
      providers: [
        {
          async resolveServiceAccountToken() {
            return undefined;
          },
        },
      ],
    });
    hostEnvironment.OP_SERVICE_ACCOUNT_TOKEN = 'changed-token';

    assert.equal(await service.resolveServiceAccountToken('data'), 'environment-token');
  });

  it('should ignore blank provider and fallback values', async () => {
    const service = new OnePasswordCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: '  ' },
      providers: [
        {
          async resolveServiceAccountToken() {
            return '';
          },
        },
      ],
    });

    assert.equal(await service.resolveServiceAccountToken('data'), undefined);
  });
});
