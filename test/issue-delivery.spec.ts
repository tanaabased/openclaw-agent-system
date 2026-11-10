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
  it('should reconcile retired push and content attempts using exact provider reads only', async () => {
    const f = fixture();
    const execute = f.provider.client.execute;
    let remoteHead = f.input.headSha;
    let repositoryId = 'R_repo';
    f.provider.client.execute = async (argv) => {
      assert.ok(!argv.includes('POST') && !argv.includes('PATCH') && !argv.includes('DELETE'));
      const value = argv.includes('repos/owner/repo')
        ? { nodeId: repositoryId }
        : argv.includes('repos/owner/repo/git/ref/heads/task')
          ? { sha: remoteHead }
          : argv.includes('{nodeId:.user.node_id}')
            ? { nodeId: 'U_agent' }
            : undefined;
      if (value)
        return {
          exitCode: 0,
          stdout: 'HTTP/2 200 OK\n\n' + JSON.stringify(value),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      return execute(argv);
    };
    const pendingPush = { head: f.input.headSha };
    assert.equal(await f.provider.retirementOutcome(f.input, { pendingPush }), true);
    remoteHead = 'c'.repeat(40);
    assert.equal(await f.provider.retirementOutcome(f.input, { pendingPush }), false);
    const content = { ...f.input, contentUpdate: { title: 'Title', body: '' } };
    f.observed.state = 'closed';
    assert.equal(await f.provider.retirementOutcome(content, {}), true);
    content.contentUpdate.body = 'unobserved content';
    assert.equal(await f.provider.retirementOutcome(content, {}), false);
    repositoryId = 'R_other';
    await assert.rejects(f.provider.retirementOutcome(f.input, {}), /repository-identity-changed/);
  });

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

  it('should inspect the announced pr without requiring closing prose or another linkage read', async () => {
    const f = fixture();
    f.observed.headSha = f.input.headSha;
    const execute = f.provider.client.execute;
    f.provider.client.execute = async (argv) => {
      assert.ok(!argv.includes('graphql') && !argv.includes('POST') && !argv.includes('PATCH'));
      const value = argv.includes('repos/owner/repo/issues/3')
        ? { databaseId: 3, nodeId: 'I_issue', number: 3, title: 'Issue' }
        : argv.some((arg) => arg.includes('draft,state'))
          ? {
              nodeId: 'PR_7',
              draft: false,
              state: 'open',
              head: f.input.headSha,
              title: 'Title',
              body: '',
            }
          : undefined;
      if (!value) return execute(argv);
      return {
        exitCode: 0,
        stdout: 'HTTP/2 200 OK\n\n' + JSON.stringify(value),
        stderr: '',
        timedOut: false,
        truncated: false,
      };
    };
    assert.equal((await f.provider.announcement(f.input)).pullRequestNumber, 7);
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

describe('github delivery explicit issue link', () => {
  function linkFixture() {
    const f = fixture();
    f.observed.headSha = f.input.headSha;
    const execute = f.provider.client.execute;
    let linked = false;
    let returnedIssue = 'I_issue';
    let failure: 'denied' | 'lost' | undefined;
    let writes = 0;
    let reads = 0;
    let authorized = false;
    const input = {
      ...f.input,
      linkIssue: true,
      recipients: [],
      async beforeLink() {
        authorized = true;
      },
    };
    f.provider.client.execute = async (argv, stdin) => {
      let value: unknown;
      if (argv.includes('graphql')) {
        const request = JSON.parse(stdin!);
        if (request.query.startsWith('mutation')) {
          assert.equal(authorized, true);
          assert.deepEqual(request.variables, { issue: 'I_issue', pullRequests: ['PR_7'] });
          writes++;
          if (failure === 'denied')
            return {
              exitCode: 1,
              stdout: 'HTTP/2 403 Forbidden\n\n{}',
              stderr: 'gh: Resource not accessible by integration (HTTP 403)',
              timedOut: false,
              truncated: false,
            };
          linked = true;
          if (failure === 'lost') throw new Error('link response lost');
          value = {
            id: returnedIssue,
          };
        } else {
          reads++;
          value = {
            id: 'PR_7',
            closingIssuesReferences: { nodes: linked ? [{ id: 'I_issue' }] : [] },
          };
        }
      } else if (argv.includes('repos/owner/repo/issues/3')) {
        value = { databaseId: 3, nodeId: 'I_issue', number: 3, title: 'Title' };
      } else if (argv.includes('{nodeId:.user.node_id}')) value = { nodeId: 'U_agent' };
      else return execute(argv);
      return {
        exitCode: 0,
        stdout: 'HTTP/2 200 OK\n\n' + JSON.stringify(value),
        stderr: '',
        timedOut: false,
        truncated: false,
      };
    };
    return {
      ...f,
      input,
      writes: () => writes,
      reads: () => reads,
      link: () => {
        linked = true;
      },
      fail: (mode: typeof failure) => {
        failure = mode;
      },
      returned: (issue: string) => {
        returnedIssue = issue;
      },
    };
  }

  it('should set the exact closing association without body writes or timed polling', async () => {
    const f = linkFixture();
    await f.provider.publish(f.input);
    assert.equal(f.writes(), 1);
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.delays, []);
    await f.provider.publish(f.input);
    assert.equal(f.writes(), 1);
  });

  it('should preserve an existing association without writing', async () => {
    const f = linkFixture();
    f.link();
    await f.provider.publish(f.input);
    assert.equal(f.writes(), 0);
  });

  it('should stop on revoked authority before linking', async () => {
    const f = linkFixture();
    f.input.beforeLink = async () => {
      throw new Error('revoked');
    };
    await assert.rejects(f.provider.publish(f.input), /revoked/);
    assert.equal(f.writes(), 0);
  });

  it('should surface a rejected write without polling or retrying it', async () => {
    const f = linkFixture();
    f.fail('denied');
    await assert.rejects(f.provider.publish(f.input), /could not reconcile issue delivery/);
    assert.equal(f.writes(), 1);
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.delays, []);
  });

  it('should reconcile a lost response by reading the existing association', async () => {
    const f = linkFixture();
    f.fail('lost');
    await assert.rejects(f.provider.publish(f.input), /link response lost/);
    await f.provider.publish(f.input);
    assert.equal(f.writes(), 1);
    assert.equal(f.reads(), 2);
    assert.deepEqual(f.delays, []);
  });

  for (const issue of ['I_other', ''])
    it(`should reject a mutation response with ${issue ? 'another issue' : 'no issue identity'}`, async () => {
      const f = linkFixture();
      f.returned(issue);
      await assert.rejects(f.provider.publish(f.input), /linkage-unverified/);
      assert.equal(f.writes(), 1);
      assert.deepEqual(f.delays, []);
    });
});
