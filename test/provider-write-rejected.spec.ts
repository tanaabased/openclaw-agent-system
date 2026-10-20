import assert from 'node:assert/strict';
import providerWriteRejected from '../utils/provider-write-rejected.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';

describe('utils/provider-write-rejected', () => {
  it('distinguishes definitive rejection from an uncertain write outcome', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 408, 500, 502, 503]) {
      const error = Object.assign(new Error('provider failure'), {
        providerDiagnostic: providerDiagnostic('github', 'api-request', 'unknown', {
          httpStatus: status,
        }),
      });
      assert.equal(providerWriteRejected(error), status < 500 && status !== 408);
    }
    assert.equal(providerWriteRejected(new Error('response lost')), false);
    assert.equal(providerWriteRejected({ message: 'HTTP 403' }), false);
  });
});
