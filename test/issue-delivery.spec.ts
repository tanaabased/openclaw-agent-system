import assert from 'node:assert/strict';
import publishIssueDelivery from '../agent/publish-issue-delivery.ts';
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
          stdout: 'HTTP/2 200 OK\n\n' + JSON.stringify(value),
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
  it('should read existing pr content from the provider and reject another identity', async () => {
    const f = fixture();
    const input = { repository: 'owner/repo', number: 7, nodeId: 'PR_7' };
    Object.assign(f.observed, { title: 'Current PR title', body: '' });
    assert.deepEqual(await f.provider.content(input), { title: 'Current PR title', body: '' });
    Object.assign(f.observed, { body: 'Latest requirements. '.repeat(2000) });
    assert.equal((await f.provider.content(input)).body, 'Latest requirements. '.repeat(2000));
    f.observed.nodeId = 'PR_other';
    await assert.rejects(f.provider.content(input), /delivery-content-identity-mismatch/);
  });

  for (const body of [
    'Closes #3',
    'Fixes owner/repo#3.',
    'Resolves https://github.com/owner/repo/issues/3',
    'Mentions #3',
    'Closes #30',
    'Closes other/repo#3',
  ])
    it(`should verify the provider-retained closing reference ${body.toLowerCase()} without an index read or write`, async () => {
      const f = fixture();
      f.observed.headSha = f.input.headSha;
      const execute = f.provider.client.execute;
      f.provider.client.execute = async (argv) => {
        assert.ok(!argv.includes('POST') && !argv.includes('PATCH') && !argv.includes('graphql'));
        let value: unknown;
        if (argv.includes('repos/owner/repo/issues/3'))
          value = { databaseId: 3, nodeId: 'I_issue', number: 3, title: 'Issue' };
        else if (argv.includes('repos/owner/repo/pulls'))
          value = [
            {
              baseRef: 'main',
              body: 'Closes #3',
              headRef: 'task',
              headRepository: 'owner/repo',
              itemNodeId: 'PR_7',
              number: 7,
              state: 'open',
              title: 'Title',
            },
          ];
        else if (argv.some((arg) => arg.includes('draft,state')))
          value = {
            nodeId: 'PR_7',
            draft: false,
            state: 'open',
            head: f.input.headSha,
            title: 'Title',
            body,
          };
        else return execute(argv);
        return {
          exitCode: 0,
          stdout: 'HTTP/2 200 OK\n\n' + JSON.stringify(value),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      };
      if (body.startsWith('Mentions') || body.includes('#30') || body.includes('other/repo'))
        await assert.rejects(f.provider.announcement(f.input), {
          message: 'github-delivery-closing-reference-missing',
        });
      else assert.equal((await f.provider.announcement(f.input)).body, body);
    });

  for (const variant of ['retained', 'dropped', 'rebound'] as const)
    it(`should require the closing-reference write to retain its exact body and pr identity when ${variant}`, async () => {
      const f = fixture();
      f.observed.headSha = f.input.headSha;
      const execute = f.provider.client.execute;
      const pr = {
        baseRef: 'main',
        body: 'Authored body.',
        headRef: 'task',
        headRepository: 'owner/repo',
        itemNodeId: 'PR_7',
        number: 7,
        state: 'open',
        title: 'Title',
      };
      let writes = 0;
      f.provider.client.execute = async (argv, stdin) => {
        assert.ok(!argv.includes('graphql') && !argv.includes('POST'));
        let value: unknown;
        if (argv.includes('repos/owner/repo/issues/3'))
          value = { databaseId: 3, nodeId: 'I_issue', number: 3, title: 'Issue' };
        else if (argv.includes('repos/owner/repo/pulls')) value = [pr];
        else if (argv.includes('PATCH')) {
          writes++;
          value = {
            ...pr,
            ...(variant === 'dropped' ? {} : JSON.parse(stdin!)),
            ...(variant === 'rebound' ? { itemNodeId: 'PR_other' } : {}),
          };
        } else return execute(argv);
        return {
          exitCode: 0,
          stdout: 'HTTP/2 200 OK\n\n' + JSON.stringify(value),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      };
      const publish = () => f.provider.publish({ ...f.input, linkIssue: true, recipients: [] });
      if (variant === 'retained') assert.deepEqual(await publish(), f.input.expectedPullRequest);
      else
        await assert.rejects(publish(), (error) =>
          /(?:unverified|binding-node-id-changed)/.test(openClawDispatchFailureCode(error)),
        );
      assert.equal(writes, 1);
      assert.deepEqual(f.delays, []);
    });
  it('should conditionally revalidate delivery reads and still reject a changed remote head', async () => {
    const f = fixture();
    f.observed.headSha = f.input.headSha;
    const execute = f.provider.client.execute;
    let reuse = false;
    const validators: boolean[] = [];
    f.provider.client.execute = async (...args) => {
      const conditional = args[0].some((value) => value.startsWith('If-None-Match:'));
      validators.push(conditional);
      if (reuse && conditional)
        return {
          exitCode: 1,
          stdout: 'HTTP/2 304 Not Modified\n\n',
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      const result = await execute(...args);
      return { ...result, stdout: result.stdout.replace('200 OK\n', '200 OK\netag: "read"\n') };
    };
    await f.provider.inspect(f.input);
    reuse = true;
    await f.provider.inspect(f.input);
    assert.deepEqual(validators, [false, false, true, true]);
    reuse = false;
    f.observed.headSha = 'c'.repeat(40);
    await assert.rejects(
      f.provider.inspect(f.input),
      (error) => openClawDispatchFailureCode(error) === 'github-delivery-binding-head-changed',
    );
  });
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

describe('shared delivery push recovery', () => {
  function publicationFixture() {
    const f = fixture();
    const publication: IssueDeliveryInput & { headSha: string } = { ...f.input };
    delete publication.previousHeadSha;
    let remote = f.input.previousHeadSha;
    let pushes = 0;
    let saved = '';
    const input: Parameters<typeof publishIssueDelivery>[0] = {
      delivery: {
        creationAttempted: true,
        pushedHead: remote,
        pullRequest: f.input.expectedPullRequest,
        reconciled: true,
      },
      publication,
      provider: {
        inspect: (value) => f.provider.inspect(value),
        async publish(value) {
          await f.provider.inspect(value);
          return f.input.expectedPullRequest;
        },
      },
      async git(argv) {
        if (argv[0] === 'ls-remote') return `${remote}\trefs/heads/task`;
        if (argv[0] === 'remote') return 'https://github.com/owner/repo.git';
        if (argv[0] === 'branch') return '';
        if (argv[0] === 'merge-base') return '';
        if (argv[0] === 'push') {
          // the pending transition must survive a process interruption after push.
          assert.deepEqual(JSON.parse(saved).pendingPush, {
            previousHead: remote,
            head: publication.headSha,
          });
          remote = publication.headSha;
          pushes++;
          return '';
        }
        throw new Error(`unexpected git operation: ${argv[0]}`);
      },
      async authorize() {},
      async save() {
        saved = JSON.stringify(input.delivery);
      },
    };
    return {
      ...f,
      input,
      pushes: () => pushes,
      restore: () => {
        input.delivery = JSON.parse(saved);
      },
    };
  }

  it('should never replay a reserved push when its remote outcome is still unknown', async () => {
    const f = publicationFixture();
    let attempts = 0;
    f.input.push = async () => {
      attempts++;
      throw new Error('transport-lost');
    };
    await assert.rejects(publishIssueDelivery(f.input), /transport-lost/);
    f.restore();
    await assert.rejects(publishIssueDelivery(f.input), /delivery-push-uncertain/);
    assert.equal(attempts, 1);
    assert.equal(f.input.delivery.pendingPush?.head, f.input.publication.headSha);
  });

  it('should reconcile a confirmed prior push before publishing newer work after a provider failure', async () => {
    const f = publicationFixture();
    f.input.provider.publish = async () => {
      throw new Error('recipient unavailable');
    };
    await assert.rejects(publishIssueDelivery(f.input), /recipient unavailable/);
    f.restore();
    const priorHead = f.input.publication.headSha;
    f.observed.headSha = priorHead;
    f.input.publication.headSha = 'c'.repeat(40);
    f.input.provider.publish = async (value) => {
      assert.equal(value.previousHeadSha, priorHead);
      return f.input.publication.expectedPullRequest!;
    };
    await publishIssueDelivery(f.input);
    assert.equal(f.pushes(), 2);
    assert.equal(f.input.delivery.pendingPush, undefined);
    assert.equal(f.input.delivery.reconciled, true);
  });

  it('should retain the exact pre-push head across restart and reconcile without pushing twice', async () => {
    const f = publicationFixture();
    const pending = (error: unknown) =>
      openClawDispatchFailureCode(error) === 'github-delivery-head-not-observed';
    await assert.rejects(publishIssueDelivery(f.input), pending);
    f.restore();
    assert.equal(f.pushes(), 1);
    assert.equal(f.input.delivery.reconciled, false);
    // the same stale provider response remains recoverable on the next invocation.
    await assert.rejects(publishIssueDelivery(f.input), pending);
    assert.deepEqual(f.delays, [250, 500, 1000, 250, 500, 1000]);
    f.restore();
    f.observed.headSha = f.input.publication.headSha;
    await publishIssueDelivery(f.input);
    assert.equal(f.pushes(), 1);
    assert.equal(f.input.delivery.reconciled, true);
    assert.equal(f.input.delivery.pendingPush, undefined);
    assert.deepEqual(f.input.delivery.pullRequest, {
      pullRequestNodeId: 'PR_7',
      pullRequestNumber: 7,
    });
  });

  it('should reject an unrelated provider head even with a retained pending push', async () => {
    const f = publicationFixture();
    await assert.rejects(publishIssueDelivery(f.input));
    f.restore();
    f.observed.headSha = 'c'.repeat(40);
    const reads = f.reads();
    await assert.rejects(
      publishIssueDelivery(f.input),
      (error) => openClawDispatchFailureCode(error) === 'github-delivery-binding-head-changed',
    );
    assert.equal(f.reads(), reads + 1);
    assert.equal(f.pushes(), 1);
    assert.equal(f.input.delivery.reconciled, false);
  });
});
