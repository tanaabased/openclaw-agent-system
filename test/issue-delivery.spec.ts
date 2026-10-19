import assert from 'node:assert/strict';
import IssueDeliveryProvider, {
  type IssueDeliveryInput,
} from '../channels/github/publication/issue-delivery.ts';
import { openClawDispatchFailureCode } from '../agent/openclaw-dispatch.ts';

function fixture() {
  const head = 'b'.repeat(40),
    previous = 'a'.repeat(40);
  const observed = {
    nodeId: 'PR_7',
    repositoryId: 'R_repo',
    headRepositoryId: 'R_repo',
    headSha: previous,
    authorId: 'U_agent',
    baseRef: 'main',
    headRef: 'task',
    state: 'open',
    number: 7,
  };
  const delays: number[] = [];
  let reads = 0;
  const provider = new IssueDeliveryProvider(
    {
      identity: { login: 'agent', nodeId: 'U_agent' },
      async execute(argv) {
        const value = argv.includes('repos/owner/repo/pulls')
          ? [
              {
                baseRef: 'main',
                body: '',
                headRef: 'task',
                headRepository: 'owner/repo',
                itemNodeId: 'PR_7',
                number: 7,
                state: 'open',
                title: 'Title',
              },
            ]
          : (++reads, observed);
        return {
          exitCode: 0,
          stdout: JSON.stringify(value),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      },
    },
    async (milliseconds) => {
      delays.push(milliseconds);
    },
  );
  const input = {
    item: {
      number: 3,
      itemDatabaseId: 3,
      itemNodeId: 'I_issue',
      repositoryOwner: 'owner',
      repositoryName: 'repo',
      repositoryDefaultBranch: 'main',
    },
    branch: 'task',
    repositoryNodeId: 'R_repo',
    headSha: head,
    previousHeadSha: previous,
    expectedPullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
  } satisfies IssueDeliveryInput;
  return { provider, input, observed, delays, reads: () => reads };
}

describe('github delivery head observation', () => {
  it('should retry only the exact previously verified head and bound the wait', async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.inspect(f.input),
      (error) => openClawDispatchFailureCode(error) === 'github-delivery-head-not-observed',
    );
    assert.deepEqual(f.delays, [250, 500, 1000]);
    assert.equal(f.reads(), 4);
  });
  for (const field of [
    'headSha',
    'authorId',
    'repositoryId',
    'headRepositoryId',
    'nodeId',
    'baseRef',
    'headRef',
    'state',
  ] as const)
    it(`should stop immediately when ${field.toLowerCase()} differs from the retained binding`, async () => {
      const f = fixture();
      f.observed[field] = 'different';
      await assert.rejects(f.provider.inspect(f.input), (error) =>
        /^github-delivery-binding-.*-changed$/.test(openClawDispatchFailureCode(error)),
      );
      assert.deepEqual(f.delays, []);
      assert.equal(f.reads(), 1);
    });
  it('should reject an old head when no verified pre-push observation was supplied', async () => {
    const f = fixture();
    await assert.rejects(
      f.provider.inspect({ ...f.input, previousHeadSha: undefined }),
      (error) => openClawDispatchFailureCode(error) === 'github-delivery-binding-head-changed',
    );
    assert.deepEqual(f.delays, []);
  });
});
