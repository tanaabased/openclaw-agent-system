import assert from 'node:assert/strict';

import taskUpdate, { type TaskUpdateDraft } from '../agent/task-update.ts';

function fixture() {
  const draft: TaskUpdateDraft = {};
  const comments = new Map<string, { nodeId: string; databaseId: number; body: string }>();
  let writes = 0;
  let lost = false;
  let destination = 3;
  const publication = (text: string) => ({
    intent: 'status-update' as const,
    publicationId: 'fact-revision',
    item: {
      lifecycleId: 'issue' as const,
      repositoryNodeId: 'R_repo',
      repositoryOwner: 'owner',
      repositoryName: 'repo',
      number: destination,
    },
    text,
  });
  const dependencies = {
    redactText: (text: string) => text,
    authorize: () => ({ authorized: true as const }),
    connect: () => ({
      client: {
        findOwnIssueComment: async (
          _owner: string,
          _name: string,
          number: number,
          marker: string,
        ) =>
          [...comments.values()].find((comment) => comment.body.includes(marker) && number === 3),
        createIssueComment: async (
          _owner: string,
          _name: string,
          _number: number,
          body: string,
        ) => {
          const comment = { nodeId: `IC_${++writes}`, databaseId: writes, body };
          comments.set(comment.nodeId, comment);
          if (lost) throw new Error('response-lost');
          return comment;
        },
      },
    }),
    exclusive: async <T>(_key: string, run: () => Promise<T>) => run(),
  };
  const run = (request: Parameters<typeof taskUpdate>[0]['request']) =>
    taskUpdate({
      request,
      draft,
      publication,
      dependencies,
      save: async () => {},
    });
  return {
    draft,
    run,
    move: () => {
      destination = 4;
    },
    lose: () => {
      lost = true;
    },
    get writes() {
      return writes;
    },
  };
}

describe('agent/task-update', () => {
  const candidate = {
    operation: 'candidate',
    text: 'The revised plan removes the extra step.',
    digest: 'current',
    expectedDigest: 'current',
  } as const;
  const publish = { operation: 'publish', digest: 'preview', expectedDigest: 'preview' } as const;
  it('should retain and publish current conversation facts without an assessment or implementation result', async () => {
    const f = fixture();
    assert.equal((await f.run(candidate)).status, 'candidate-recorded');
    assert.equal(f.writes, 0);
    assert.equal(JSON.parse(f.draft.publication!).text, candidate.text);
    assert.equal((await f.run(publish)).status, 'published');
    assert.equal(f.draft.receipt?.nodeId, 'IC_1');
    assert.equal(f.writes, 1);
  });
  it('should reject changed destinations and stale previews without replacing the pending draft', async () => {
    const f = fixture();
    await f.run(candidate);
    const before = structuredClone(f.draft);
    await assert.rejects(f.run({ ...publish, digest: 'old' }), /task-update-stale/);
    f.move();
    await assert.rejects(f.run(publish), /task-update-destination-changed/);
    assert.deepEqual(f.draft, before);
    assert.equal(f.writes, 0);
  });
  it('should reconcile an uncertain write without another create while independent updates proceed', async () => {
    const f = fixture();
    await f.run(candidate);
    f.lose();
    await assert.rejects(f.run(publish), /response-lost/);
    assert.equal(f.draft.attempted, true);
    const other = fixture();
    await other.run(candidate);
    assert.equal((await other.run(publish)).status, 'published');
    await assert.rejects(f.run(candidate), /task-update-already-attempted/);
    assert.equal((await f.run({ operation: 'reconcile', expectedDigest: '' })).status, 'published');
    assert.equal(f.writes, 1);
  });
  it('should reject a missing original publication without reconstructing or replaying it', async () => {
    const f = fixture();
    await f.run(candidate);
    await f.run(publish);
    const receipt = structuredClone(f.draft.receipt);
    delete f.draft.publication;
    await assert.rejects(
      f.run({ operation: 'reconcile', expectedDigest: '' }),
      /task-update-publication-required/,
    );
    assert.equal(f.draft.publication, undefined);
    assert.deepEqual(f.draft.receipt, receipt);
    assert.equal(f.writes, 1);
  });
});
