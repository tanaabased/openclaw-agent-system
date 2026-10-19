import assert from 'node:assert/strict';
import registrationEvidence from '../scripts/registration-evidence.js';

const config = {
  agents: { entries: { tanaabot: { workspace: '/fixture', identity: { secret: 'private' } } } },
  gateway: { auth: { token: 'secret-token' }, reload: { mode: 'hybrid' } },
};
const saved = () => ({ text: JSON.stringify(config), ino: 42, mtimeMs: 123, size: 456 });

describe('registration evidence', () => {
  it('should retain the legacy roster projection without exposing identity data', () => {
    const evidence = registrationEvidence({
      configPath: '/fixture/openclaw.json',
      read: () => ({
        ...saved(),
        text: JSON.stringify({
          agents: {
            list: [{ id: 'legacy', workspace: '/legacy', identity: { secret: 'private' } }],
          },
        }),
      }),
      request: () => ({}),
    });
    assert.deepEqual((evidence.saved.value as { agents: unknown }).agents, [
      { id: 'legacy', workspace: '/legacy' },
    ]);
    assert.doesNotMatch(JSON.stringify(evidence), /secret|private/u);
  });
  it('should distinguish saved and observed config from the running agent list without exposing secrets', () => {
    const calls: string[] = [];
    const evidence = registrationEvidence({
      configPath: '/fixture/openclaw.json',
      read: saved,
      request(method) {
        calls.push(method);
        return method === 'config.get'
          ? {
              path: '/different/openclaw.json',
              valid: true,
              config,
              configRevisionHash: 'new',
              appliedConfigHash: 'old',
              raw: 'secret-raw',
            }
          : { agents: [{ id: 'emori', identity: 'secret-identity' }] };
      },
    });
    assert.deepEqual(calls, ['config.get', 'agents.list']);
    assert.deepEqual(evidence.saved.value, {
      path: '/fixture/openclaw.json',
      ino: 42,
      mtimeMs: 123,
      size: 456,
      agents: [{ id: 'tanaabot', workspace: '/fixture' }],
      reloadMode: 'hybrid',
    });
    assert.deepEqual(evidence.gatewaySnapshot.value, {
      path: '/different/openclaw.json',
      valid: true,
      configRevisionHash: 'new',
      appliedConfigHash: 'old',
      agents: [{ id: 'tanaabot', workspace: '/fixture' }],
    });
    assert.deepEqual(evidence.runningAgents.value, [{ id: 'emori', workspace: null }]);
    assert.doesNotMatch(JSON.stringify(evidence), /secret|private/u);
  });

  it('should retain independent observations when config inspection fails without printing raw errors', () => {
    const evidence = registrationEvidence({
      configPath: '/fixture/openclaw.json',
      read() {
        throw new Error('secret-file-error');
      },
      request(method) {
        if (method === 'config.get') throw new Error('secret-rpc-error');
        return { agents: [{ id: 'tanaabot' }] };
      },
    });
    assert.deepEqual(evidence.saved, { status: 'unavailable' });
    assert.deepEqual(evidence.gatewaySnapshot, { status: 'unavailable' });
    assert.deepEqual(evidence.runningAgents.value, [{ id: 'tanaabot', workspace: null }]);
    assert.doesNotMatch(JSON.stringify(evidence), /secret/u);
  });
});
