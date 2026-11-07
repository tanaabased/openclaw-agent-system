import assert from 'node:assert/strict';
import taskPullRequest, { setTaskPullRequestLink } from '../agent/task-pull-request.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('agent/task-pull-request', () => {
  it('should change or clear the current association without rewriting earlier operation receipts', () => {
    const original = { pullRequestNodeId: 'old-pr', pullRequestNumber: 7 };
    const record: Pick<SharedDispatchRecord, 'pullRequestLink'> & {
      delivery: { pullRequest: typeof original };
    } = {
      delivery: { pullRequest: original },
    };
    assert.deepEqual(taskPullRequest(record), original);
    record.pullRequestLink = { pullRequestNodeId: 'new-pr', pullRequestNumber: 8 };
    assert.equal(taskPullRequest(record)?.pullRequestNumber, 8);
    record.pullRequestLink = null;
    assert.equal(taskPullRequest(record), undefined);
    assert.deepEqual(record.delivery.pullRequest, original);
  });

  it('should clear a link without requiring a provider operation', async () => {
    const record = {
      pullRequestLink: { pullRequestNodeId: 'old-pr', pullRequestNumber: 7 },
    } as Pick<SharedDispatchRecord, 'pullRequestLink'>;
    const { client } = intakeFixture();
    await setTaskPullRequestLink(record, {} as Parameters<typeof setTaskPullRequestLink>[1], null, {
      ...client,
      getRepository: async () => {
        throw new Error('unexpected provider read');
      },
      getItem: async () => {
        throw new Error('unexpected provider read');
      },
    });
    assert.equal(taskPullRequest(record), undefined);
  });
});
