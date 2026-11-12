import assert from 'node:assert/strict';
import taskPullRequest, {
  isCurrentTaskPullRequest,
  setTaskPullRequestLink,
} from '../agent/tasks/delivery/task-pull-request.ts';
import type { SharedDispatchRecord } from '../agent/tasks/dispatch/dispatch-state.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('agent/task-pull-request', () => {
  it('should identify the current repository-qualified pr without reviving a cleared or replaced association', () => {
    const { repository } = intakeFixture();
    const original = { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 };
    for (const delivery of [
      { delivery: { pullRequest: original } },
      { delivery: { pullRequest: original }, work: {} },
    ]) {
      const record: Parameters<typeof taskPullRequest>[0] = delivery;
      const url = 'https://github.com/owner/repo/pull/7';
      assert.equal(isCurrentTaskPullRequest(record, { repository }, url), true);
      for (const target of [
        undefined,
        null,
        'https://github.com/owner/repo/pull/8',
        'https://github.com/other/repo/pull/7',
      ])
        assert.equal(isCurrentTaskPullRequest(record, { repository }, target), false);
      record.pullRequestLink = { pullRequestNodeId: 'PR_8', pullRequestNumber: 8 };
      assert.equal(isCurrentTaskPullRequest(record, { repository }, url), false);
      record.pullRequestLink = null;
      assert.equal(isCurrentTaskPullRequest(record, { repository }, url), false);
    }
  });

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
