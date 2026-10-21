import assert from 'node:assert/strict';
import closeResetPullRequest from '../channels/github/provider/reset-pull-request.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';

describe('channels/github/reset pull request', () => {
  const intake = {
    receiving: { nodeId: 'user' },
    repository: { owner: { login: 'owner' }, name: 'repo', nodeId: 'repo', databaseId: 10 },
  } as IntakeRecord;
  const receipt = { pullRequestNodeId: 'pr', pullRequestNumber: 2 };
  const row = {
    node_id: 'pr',
    number: 2,
    merged: false,
    state: 'open',
    base: { repo: { node_id: 'repo', id: 10 } },
  };
  const ok = (body: unknown) => ({
    stdout: JSON.stringify(body),
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false,
  });
  it('should reconcile a close whose response was lost', async () => {
    let closed = false;
    const writes: string[][] = [];
    await closeResetPullRequest(
      {
        identity: { login: 'tester', nodeId: 'user' },
        execute: async (argv, input) => {
          if (input) {
            writes.push(argv);
            closed = true;
            return { ...ok({}), exitCode: 1 };
          }
          return ok({ ...row, state: closed ? 'closed' : 'open' });
        },
      },
      intake,
      receipt,
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.includes('DELETE'), false);
  });
  it('should leave merged and already closed pull requests untouched', async () => {
    for (const pr of [
      { ...row, merged: true },
      { ...row, state: 'closed' },
    ]) {
      await closeResetPullRequest(
        {
          identity: { login: 'tester', nodeId: 'user' },
          execute: async (_argv, input) => {
            assert.equal(input, undefined);
            return ok(pr);
          },
        },
        intake,
        receipt,
      );
    }
  });
  it('should reject replacement identities before any write', async () => {
    await assert.rejects(
      closeResetPullRequest(
        {
          identity: { login: 'tester', nodeId: 'user' },
          execute: async (_argv, input) => {
            assert.equal(input, undefined);
            return ok({ ...row, node_id: 'other' });
          },
        },
        intake,
        receipt,
      ),
      /notification-reset-pr-identity-changed/u,
    );
  });
});
