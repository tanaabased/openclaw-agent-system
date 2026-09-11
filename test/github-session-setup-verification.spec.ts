import assert from 'node:assert/strict';
import SessionSetupVerification, {
  type SessionSetupEntry,
} from '../channels/github/conversation/session-setup-verification.ts';

const input = { agentId: 'data', sessionKey: 'agent:data:github:issue:one' };
const configured: SessionSetupEntry = {
  owner: { actor: { type: 'agent', id: 'data' } },
  color: 'green',
  category: 'Work',
};

function fixture() {
  let entry: SessionSetupEntry | undefined;
  const logs: string[] = [];
  const service = new SessionSetupVerification({
    logger: { info: (text) => logs.push(text), warn: (text) => logs.push(text) },
    runtime: {
      getSessionEntry(params) {
        assert.equal(params.readConsistency, 'latest');
        return entry;
      },
    },
  });
  return {
    service,
    logs,
    set entry(value: SessionSetupEntry | undefined) {
      entry = value;
    },
    get entry() {
      return entry;
    },
  };
}

describe('assignment session setup verification', () => {
  it('should verify persisted routed ownership, color, and the tool-selected group', async () => {
    const f = fixture();
    await f.service.run(input, async () => {
      f.service.observe(
        {
          toolName: 'sessions',
          params: { action: 'assign_owner', ownerType: 'agent', ownerId: 'data' },
          result: {},
        },
        input,
      );
      f.service.observe(
        {
          toolName: 'sessions',
          params: { action: 'patch', color: 'green', group: 'Work' },
          result: {},
        },
        input,
      );
      f.entry = structuredClone(configured);
    });
    assert.ok(f.logs.some((message) => message.includes('setup verified')));
  });

  it('should not treat manual fields or successful prompt text as automation evidence', async () => {
    const f = fixture();
    f.entry = structuredClone(configured);
    await f.service.run(input, async () => 'setup complete');
    assert.ok(f.logs[0]?.includes('preserved'));
    assert.deepEqual(f.entry, configured);
    f.entry = undefined;
    await f.service.run(input, async () => {
      f.entry = structuredClone(configured);
    });
    assert.ok(f.logs[1]?.includes('tool-evidence-unavailable'));
  });

  it('should warn on missing tools, invalid values, and denied calls without blocking work', async () => {
    const f = fixture();
    const result = await f.service.run(input, async () => {
      f.service.observe(
        {
          toolName: 'sessions',
          params: { action: 'patch' },
          error: 'owner-only: secret diagnostic never echoed',
        },
        input,
      );
      f.entry = {
        ...configured,
        owner: { actor: { type: 'agent', id: 'someone-else' } },
        color: 'invalid',
      };
      return 42;
    });
    assert.equal(result, 42);
    assert.ok(f.logs[0]?.includes('code=owner-denied'));
    assert.ok(!f.logs.join('').includes('secret diagnostic'));
    assert.equal(f.entry?.owner?.actor.id, 'someone-else');
  });

  it('should preserve turn failures and report unreadable state without retries', async () => {
    const logs: string[] = [];
    let reads = 0;
    const service = new SessionSetupVerification({
      logger: { info() {}, warn: (text) => logs.push(text) },
      runtime: {
        getSessionEntry() {
          reads++;
          throw new Error('unreadable');
        },
      },
    });
    await assert.rejects(
      service.run(input, async () => {
        throw new Error('original turn failure');
      }),
      /original turn failure/,
    );
    assert.equal(reads, 2);
    assert.ok(logs[0]?.includes('state-unreadable'));
  });
});
