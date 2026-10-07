import assert from 'node:assert/strict';

import automationGatewayUnavailable from '../agent/automation-gateway-unavailable.ts';

const transport = (fields: Record<string, unknown>) =>
  Object.assign(new Error('secret connection details'), {
    name: 'GatewayTransportError',
    connectionDetails: {},
    ...fields,
  });

describe('agent/automation-gateway-unavailable', () => {
  it('should recognize unreachable sockets and pre-dispatch timeout or abnormal restart closures', () => {
    for (const error of [
      transport({ kind: 'closed' }),
      transport({ kind: 'timeout', requestDispatched: false }),
      transport({ kind: 'closed', code: 1006, requestDispatched: false }),
      transport({ kind: 'closed', code: 1012, requestDispatched: false }),
    ])
      assert.equal(automationGatewayUnavailable(error), true);
  });

  it('should reject policy protocol and unknown closures even before dispatch', () => {
    for (const code of [
      1000, 1001, 1002, 1003, 1005, 1007, 1008, 1009, 1010, 1011, 1013, 1014, 1015, 987654321,
    ])
      assert.equal(
        automationGatewayUnavailable(transport({ kind: 'closed', code, requestDispatched: false })),
        false,
      );
  });

  it('should keep dispatched or uncertain request outcomes fatal', () => {
    for (const requestDispatched of [true, undefined, null]) {
      assert.equal(
        automationGatewayUnavailable(transport({ kind: 'timeout', requestDispatched })),
        false,
      );
      for (const code of [1006, 1012])
        assert.equal(
          automationGatewayUnavailable(transport({ kind: 'closed', code, requestDispatched })),
          false,
        );
    }
    assert.equal(
      automationGatewayUnavailable(transport({ kind: 'closed', requestDispatched: true })),
      false,
    );
  });

  it('should never infer unavailability from auth rejections or unknown error prose', () => {
    for (const error of [
      new Error('gateway timeout after 10000ms'),
      Object.assign(new Error('secret'), { name: 'GatewayCredentialsRequiredError' }),
      Object.assign(new Error('secret'), {
        name: 'GatewayClientRequestError',
        gatewayCode: 'FORBIDDEN',
        retryable: false,
      }),
      null,
      'Gateway not reachable',
      {
        name: 'GatewayTransportError',
        kind: 'timeout',
        connectionDetails: {},
        requestDispatched: false,
      },
    ])
      assert.equal(automationGatewayUnavailable(error), false);
  });
});
