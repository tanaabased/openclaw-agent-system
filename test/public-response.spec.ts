import assert from 'node:assert/strict';

import publicResponse, { type PublicResponseReceipt } from '../agent/public-response.ts';
import publicResponseState from '../agent/public-response-state.ts';
import publicResponsePresentation from '../channels/github/presentation/public-response.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';

function fixture() {
  let state: { attempted: boolean; receipt?: PublicResponseReceipt } = { attempted: false };
  let saved = structuredClone(state);
  let remote: (PublicResponseReceipt & { body: string }) | undefined;
  let posts = 0;
  let mode: 'ok' | 'lost' | 'rejected' = 'ok';
  let denied = false;
  let connects = 0;
  let failReceipt = false;
  const publication = {
    intent: 'assessment-summary' as const,
    publicationId: 'stable-source',
    text: 'Public proposal.',
    item: {
      lifecycleId: 'issue' as const,
      number: 7,
      repositoryOwner: 'owner',
      repositoryName: 'repo',
      repositoryNodeId: 'R_repo',
    },
  };
  const run = (reconcileOnly = false) =>
    publicResponse({
      publication,
      attempted: state.attempted,
      receipt: state.receipt,
      reconcileOnly,
      setAttempted: (value) => {
        state.attempted = value;
      },
      setReceipt: (receipt) => {
        state.receipt = receipt;
      },
      save: async () => {
        if (failReceipt && state.receipt) throw new Error('receipt save interrupted');
        saved = structuredClone(state);
      },
      dependencies: {
        redactText: (text) => text,
        authorize: async () => {
          if (denied) throw new Error('native-approval-denied');
          return { authorized: true };
        },
        connect: async () => {
          connects++;
          return {
            client: {
              findOwnIssueComment: async () => remote,
              createIssueComment: async (_o, _n, _id, body) => {
                assert.equal(saved.attempted, true);
                posts++;
                if (mode === 'rejected')
                  throw Object.assign(new Error('permission denied'), {
                    providerDiagnostic: providerDiagnostic('github', 'api-request', 'permission', {
                      httpStatus: 403,
                    }),
                  });
                remote = { nodeId: 'C_post', databaseId: 71, body };
                if (mode === 'lost') throw new Error('response lost');
                return remote;
              },
            },
          };
        },
        exclusive: async (_key, operation) => operation(),
      },
    });
  return {
    run,
    restart: () => {
      state = JSON.parse(JSON.stringify(saved));
    },
    mode: (value: typeof mode) => {
      mode = value;
    },
    deny: () => {
      denied = true;
    },
    failReceipt: () => {
      failReceipt = true;
    },
    clear: () => {
      remote = undefined;
    },
    edit: () => {
      remote!.body = 'Edited by operator';
    },
    get state() {
      return saved;
    },
    get posts() {
      return posts;
    },
    get connects() {
      return connects;
    },
  };
}

describe('agent/public-response', () => {
  it('should resume an unattempted response and retain its verified receipt', async () => {
    const f = fixture();
    f.restart();
    assert.equal((await f.run()).status, 'published');
    assert.deepEqual(f.state.receipt, { nodeId: 'C_post', databaseId: 71 });
    assert.equal(f.posts, 1);
    await f.run();
    assert.equal(f.posts, 1);
  });
  for (const interruption of ['lost', 'receipt'] as const)
    it(`should recover an accepted post after ${interruption} interruption and restart without reposting`, async () => {
      const f = fixture();
      if (interruption === 'lost') f.mode('lost');
      else f.failReceipt();
      await assert.rejects(f.run());
      assert.equal(f.state.attempted, true);
      assert.equal(f.state.receipt, undefined);
      f.restart();
      // receipt persistence still failing is independently retriable without a second write.
      if (interruption === 'receipt') await assert.rejects(f.run());
      else assert.equal((await f.run()).status, 'published');
      assert.equal(f.posts, 1);
    });
  it('should keep an absent attempted post uncertain even on an explicit publish request', async () => {
    const f = fixture();
    f.mode('lost');
    await assert.rejects(f.run());
    f.restart();
    f.clear();
    assert.equal((await f.run()).status, 'uncertain');
    assert.equal(f.posts, 1);
  });
  it('should clear attempted only after a definitive rejection', async () => {
    const f = fixture();
    f.mode('rejected');
    await assert.rejects(f.run());
    assert.equal(f.state.attempted, false);
    f.restart();
    f.mode('ok');
    assert.equal((await f.run()).status, 'published');
    assert.equal(f.posts, 2);
  });
  it('should preserve an edited-post conflict without another write', async () => {
    const f = fixture();
    f.mode('lost');
    await assert.rejects(f.run());
    f.restart();
    f.edit();
    await assert.rejects(f.run());
    assert.equal(f.posts, 1);
  });
  it('should authorize before connection and keep read-only reconciliation free of writes', async () => {
    const f = fixture();
    assert.equal((await f.run(true)).status, 'uncertain');
    assert.equal(f.posts, 0);
    const connects = f.connects;
    f.deny();
    await assert.rejects(f.run(), /native-approval-denied/);
    assert.equal(f.connects, connects);
  });
  it('should distinguish pending, unconfirmed, blocked, withheld and delivered outcomes', () => {
    assert.equal(publicResponseState({}), 'pending');
    assert.equal(publicResponseState({ attempted: true }), 'unconfirmed');
    assert.equal(
      publicResponseState({ attempted: true, code: 'native-approval-denied' }),
      'blocked',
    );
    assert.equal(publicResponseState({ withheld: true }), 'withheld');
    assert.equal(publicResponsePresentation({ kind: 'Reply', receipt: {} }), '');
    const warning = publicResponsePresentation({
      kind: 'Assessment summary',
      attempted: true,
      destination: 'https://github.com/owner/repo/issues/7',
    });
    assert.match(warning, /unconfirmed/);
    assert.match(warning, /Do not repost/);
    assert.ok(warning.split('\n').every((line) => line.startsWith('>')));
  });
});
