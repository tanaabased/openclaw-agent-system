import assert from 'node:assert/strict';

import resolveAgentId from '../agent/resolve-id.ts';

describe('agent/resolve-id', () => {
  it('should prefer the host-supplied agent id', () => {
    assert.equal(
      resolveAgentId({ agentId: 'tanaabot', sessionKey: 'agent:other:main' }, () => 'other'),
      'tanaabot',
    );
  });

  it('should use an agent id parsed from an authoritative session key', () => {
    assert.equal(
      resolveAgentId({ sessionKey: 'agent:tanaabot:main' }, (sessionKey) =>
        sessionKey.startsWith('agent:') ? 'tanaabot' : undefined,
      ),
      'tanaabot',
    );
  });

  it('should not invent a default agent for an unscoped session key', () => {
    assert.equal(
      resolveAgentId({ sessionKey: 'legacy-session' }, () => undefined),
      undefined,
    );
  });
});
