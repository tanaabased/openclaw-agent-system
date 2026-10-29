import assert from 'node:assert/strict';

import type { AgentSystemCliResult } from '../api/types.ts';
import GitHubWorkEventClient, {
  GitHubWorkEventClientError,
} from '../channels/github/provider/work-event-client.ts';
import {
  githubNotificationPublicationMarker,
  githubNotificationPublicationTarget,
} from '../channels/github/publication/publication-contract.ts';
import { githubCommentPageSize } from '../channels/github/provider/issue-comment-client.ts';
import retryGitHubRead from '../core/github-read-retry.ts';

function response(body: unknown, link?: string): AgentSystemCliResult {
  return {
    exitCode: 0,
    stderr: '',
    stdout: [
      'HTTP/2 200 OK',
      'x-ratelimit-remaining: 100',
      ...(link ? [`link: ${link}`] : []),
      '',
      JSON.stringify(body),
    ].join('\n'),
    timedOut: false,
    truncated: false,
  };
}

describe('channels/github/provider/work-event-client', () => {
  it('should revalidate milestone observations and retain issue membership without masking denial', async () => {
    const headers: Array<string | undefined> = [];
    let denied = false;
    const account = {
      observationScope: {},
      identity: { login: 'receiver', nodeId: 'U_receiver' },
      async execute(argv: string[]) {
        if (argv.includes('/repos/owner/repo/issues/3'))
          return response({
            databaseId: 20,
            nodeId: 'I_issue',
            number: 3,
            state: 'open',
            updatedAt: '2026-10-07T10:01:00Z',
            title: 'work',
            isPullRequest: false,
            assignees: [],
            milestone: { node_id: 'MI_pilot', number: 10, state: 'open' },
          });
        assert.ok(argv.includes('/repos/owner/repo/milestones/10'));
        const conditional = argv.find((value) => value.startsWith('If-None-Match:'));
        headers.push(conditional);
        if (denied) return { ...response({}), exitCode: 1, stdout: 'HTTP/2 403 Forbidden\n\n{}' };
        if (conditional)
          return {
            ...response({}),
            exitCode: 1,
            stdout: 'HTTP/2 304 Not Modified\n\n',
            stderr: 'gh: HTTP 304',
          };
        return {
          ...response({}),
          stdout:
            'HTTP/2 200 OK\netag: "milestone"\n\n' +
            JSON.stringify({ node_id: 'MI_pilot', number: 10, state: 'open' }),
        };
      },
    };
    const client = new GitHubWorkEventClient(account);
    assert.deepEqual(await client.getMilestone('owner', 'repo', 10), {
      nodeId: 'MI_pilot',
      number: 10,
      state: 'open',
    });
    assert.equal((await client.getMilestone('owner', 'repo', 10)).state, 'open');
    const item = await client.getItem('owner', 'repo', 3);
    assert.equal(item.itemType === 'issue' && item.milestone?.nodeId, 'MI_pilot');
    denied = true;
    await assert.rejects(client.getMilestone('owner', 'repo', 10), GitHubWorkEventClientError);
    assert.deepEqual(headers, [
      undefined,
      'If-None-Match: "milestone"',
      'If-None-Match: "milestone"',
    ]);
  });

  const repository = {
    archived: false,
    disabled: false,
    cloneUrl: 'https://github.com/owner/repo.git',
    databaseId: 1,
    nodeId: 'R_repo',
    name: 'repo',
    defaultBranch: 'main',
    owner: { login: 'owner', nodeId: 'O_owner', type: 'Organization' },
  };

  it('should revalidate repository observations across connections and expose changed provider facts', async () => {
    const headers: Array<string | undefined> = [];
    let changed = false;
    const account = {
      observationScope: {},
      identity: { login: 'receiver', nodeId: 'U_receiver' },
      async execute(argv: string[]) {
        const conditional = argv.find((value) => value.startsWith('If-None-Match:'));
        headers.push(conditional);
        if (conditional && !changed)
          return {
            ...response({}),
            exitCode: 1,
            stderr: 'gh: HTTP 304',
            stdout: 'HTTP/2 304 Not Modified\nx-ratelimit-remaining: 99\n\n',
          };
        return {
          ...response({ ...repository, archived: changed }),
          stdout:
            'HTTP/2 200 OK\netag: "repo-v' +
            (changed ? '2' : '1') +
            '"\n\n' +
            JSON.stringify({ ...repository, archived: changed }),
        };
      },
    };
    const first = await new GitHubWorkEventClient(account).getRepository('owner', 'repo');
    first.owner.nodeId = 'caller-mutated';
    const second = new GitHubWorkEventClient({ ...account });
    assert.equal((await second.getRepository('owner', 'repo')).owner.nodeId, 'O_owner');
    assert.equal(second.rateLimit.remaining, 99);
    changed = true;
    assert.equal((await second.getRepository('owner', 'repo')).archived, true);
    assert.deepEqual(headers, [undefined, 'If-None-Match: "repo-v1"', 'If-None-Match: "repo-v1"']);
    changed = false;
    await new GitHubWorkEventClient({ ...account, observationScope: {} }).getRepository(
      'owner',
      'repo',
    );
    assert.equal(headers.at(-1), undefined);
  });

  it('should never substitute cached repository facts for provider errors', async () => {
    for (const status of [401, 403, 404, 503]) {
      let failing = false;
      const conditionals: boolean[] = [];
      const client = new GitHubWorkEventClient(
        {
          identity: { login: 'receiver', nodeId: 'U_receiver' },
          async execute(argv) {
            conditionals.push(argv.some((value) => value.startsWith('If-None-Match:')));
            return failing
              ? { ...response({}), exitCode: 1, stdout: 'HTTP/2 ' + status + ' Error\n\n{}' }
              : {
                  ...response(repository),
                  stdout: 'HTTP/2 200 OK\netag: "repo"\n\n' + JSON.stringify(repository),
                };
          },
        },
        undefined,
        (read, options) => retryGitHubRead(read, { ...options, sleep: async () => undefined }),
      );
      await client.getRepository('owner', 'repo');
      failing = true;
      await assert.rejects(client.getRepository('owner', 'repo'), GitHubWorkEventClientError);
      failing = false;
      await client.getRepository('owner', 'repo');
      assert.equal(conditionals[0], false);
      assert.ok(conditionals.slice(1, -1).every(Boolean));
      assert.equal(conditionals.at(-1), false);
    }
  });

  it('should reject unsolicited not-modified responses and read repositories without etags normally', async () => {
    let unsolicited = true;
    const client = new GitHubWorkEventClient({
      identity: { login: 'receiver', nodeId: 'U_receiver' },
      async execute(argv) {
        assert.equal(
          argv.some((value) => value.startsWith('If-None-Match:')),
          false,
        );
        return unsolicited
          ? { ...response({}), exitCode: 1, stdout: 'HTTP/2 304 Not Modified\n\n' }
          : response(repository);
      },
    });
    await assert.rejects(client.getRepository('owner', 'repo'), GitHubWorkEventClientError);
    unsolicited = false;
    assert.equal((await client.getRepository('owner', 'repo')).nodeId, 'R_repo');
    await client.getRepository('owner', 'repo');
  });

  it('should resolve a group of immutable identities with one provider request and reject incomplete groups', async () => {
    let missing = false;
    let requests = 0;
    const client = new GitHubWorkEventClient({
      identity: { login: 'receiver', nodeId: 'U_receiver' },
      async execute(_argv, stdin) {
        requests++;
        assert.deepEqual(JSON.parse(stdin!).variables.ids, ['U_actor', 'O_owner']);
        return response({
          data: {
            nodes: [
              { id: 'U_actor', login: 'renamed', __typename: 'User' },
              missing ? null : { id: 'O_owner', login: 'owner', __typename: 'Organization' },
            ],
          },
        });
      },
    });
    assert.deepEqual(await client.resolveIdentities(['U_actor', 'O_owner']), [
      { login: 'renamed', nodeId: 'U_actor', type: 'User' },
      { login: 'owner', nodeId: 'O_owner', type: 'Organization' },
    ]);
    assert.equal(requests, 1);
    missing = true;
    await assert.rejects(
      client.resolveIdentities(['U_actor', 'O_owner']),
      /github-identity-unresolved/,
    );
  });

  it('should resolve names and opaque node ids through bounded provider facts', async () => {
    const calls: string[][] = [];
    let missing = false;
    const client = new GitHubWorkEventClient({
      identity: { login: 'receiver', nodeId: 'U_receiver' },
      async execute(argv, stdin) {
        calls.push(argv);
        if (argv.includes('graphql')) {
          assert.equal(JSON.parse(stdin!).variables.id, 'O_owner');
          return response({
            data: {
              node: missing ? null : { id: 'O_owner', login: 'owner', __typename: 'Organization' },
            },
          });
        }
        assert.ok(argv.includes('/users/actor'));
        return response({ login: 'actor', nodeId: 'U_actor', type: 'User' });
      },
    });
    assert.deepEqual(await client.resolveIdentity('@actor'), {
      login: 'actor',
      nodeId: 'U_actor',
      type: 'User',
    });
    assert.deepEqual(await client.resolveIdentity('O_owner'), {
      login: 'owner',
      nodeId: 'O_owner',
      type: 'Organization',
    });
    missing = true;
    await assert.rejects(client.resolveIdentity('O_owner'), /github-identity-unresolved/);
    assert.equal(calls.length, 3);
  });

  it('should preserve secondary throttling instead of reporting a permission denial', async () => {
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_agent' },
      async execute() {
        return {
          ...response({}),
          exitCode: 1,
          stdout:
            'HTTP/2 403 Forbidden\nx-ratelimit-remaining: 4500\nx-ratelimit-resource: core\n\n{}',
          stderr: 'gh: You have exceeded a secondary rate limit. (HTTP 403)',
        };
      },
    });
    await assert.rejects(client.getRepository('owner', 'repo'), (error: unknown) => {
      assert.ok(error instanceof GitHubWorkEventClientError);
      assert.equal(error.providerDiagnostic?.classification, 'rate-limit');
      assert.equal(error.providerDiagnostic?.quotaScope, 'core');
      assert.equal(error.rateLimit.remaining, 4500);
      return true;
    });
  });

  it('should read bounded native routing metadata only for opted-in issue assessments', async () => {
    const requests: string[][] = [];
    let unavailable = false;
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_agent' },
      async execute(argv) {
        requests.push(argv);
        if (argv.some((argument) => argument.includes('/issue-field-values'))) {
          if (unavailable) throw new Error('metadata unavailable');
          return response([
            { issue_field_name: 'Complexity', value: 'Low' },
            { issue_field_name: 'Work size', value: 21 },
          ]);
        }
        return response({
          title: 'Repair a link',
          body: 'Localized repair.',
          labels: [],
          commentCount: 0,
        });
      },
    });
    assert.equal(
      (await client.getItemContext('tanaabased', 'example', 7)).routingMetadata,
      undefined,
    );
    assert.equal(requests.length, 1);
    const context = await client.getItemContext('tanaabased', 'example', 7, 'issue', true);
    assert.equal(context.routingMetadata?.complexity.value, 'low');
    assert.equal(context.routingMetadata?.workSize.value, 21);
    assert.ok(
      requests
        .at(-1)
        ?.includes('/repos/tanaabased/example/issues/7/issue-field-values?per_page=100'),
    );
    assert.ok(requests.at(-1)?.includes('X-GitHub-Api-Version: 2026-03-10'));
    unavailable = true;
    assert.equal(
      (await client.getItemContext('tanaabased', 'example', 7, 'issue', true)).routingMetadata
        ?.complexity.status,
      'unavailable',
    );
  });

  it('should skip provider discovery when assignment types are explicitly cleared', async () => {
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_agent' },
      async execute() {
        throw new Error('provider must not be called');
      },
    });
    assert.deepEqual(await client.discoverAssigned('2026-08-11T11:55:00.000Z', []), {
      candidates: [],
      incomplete: false,
      totalCount: 0,
      truncated: false,
    });
  });

  it('should paginate assigned-item discovery through fixed bounded api calls', async () => {
    const requests: string[][] = [];
    const pages = [
      response(
        {
          totalCount: 2,
          incomplete: false,
          items: [
            {
              databaseId: 1,
              isPullRequest: false,
              nodeId: 'I_one',
              number: 1,
              repositoryPath: 'https://api.github.com/repos/tanaabased/example',
              updatedAt: '2026-08-11T12:00:00Z',
            },
          ],
        },
        '<https://api.github.com/search/issues?page=2>; rel="next"',
      ),
      response({
        totalCount: 2,
        incomplete: false,
        items: [
          {
            databaseId: 2,
            isPullRequest: true,
            nodeId: 'PR_two',
            number: 2,
            repositoryPath: '/repos/tanaabased/example',
            updatedAt: '2026-08-11T12:01:00Z',
          },
        ],
      }),
    ];
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_agent' },
      async execute(argv) {
        requests.push(argv);
        return pages.shift() ?? response({});
      },
    });

    const discovery = await client.discoverAssigned('2026-08-11T11:55:00.000Z', [
      'issue',
      'pull-request',
    ]);

    assert.equal(discovery.truncated, false);
    assert.deepEqual(
      discovery.candidates.map(({ itemType, nodeId }) => ({ itemType, nodeId })),
      [
        { itemType: 'issue', nodeId: 'I_one' },
        { itemType: 'pull-request', nodeId: 'PR_two' },
      ],
    );
    assert.equal(requests.length, 2);
    assert.ok(requests.every((argv) => argv.slice(0, 3).join(' ') === 'api --include --method'));
    assert.ok(
      requests.every((argv) =>
        argv.includes('q=assignee:tanaabot state:open updated:>=2026-08-11T11:55:00.000Z'),
      ),
    );
  });

  it('should retain the canonical work-item database identity', async () => {
    const requests: string[][] = [];
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_agent' },
      async execute(argv) {
        requests.push(argv);
        return response({
          assignees: [{ login: 'tanaabot', nodeId: 'U_agent', type: 'User' }],
          databaseId: 42,
          isPullRequest: false,
          nodeId: 'I_item',
          number: 7,
          state: 'open',
          title: 'Fix issue branch naming',
          updatedAt: '2026-08-11T12:00:00Z',
        });
      },
    });

    const item = await client.getItem('tanaabased', 'example', 7);

    assert.equal(item.databaseId, 42);
    assert.equal(item.itemType === 'issue' ? item.title : undefined, 'Fix issue branch naming');
    assert.ok(requests[0]?.includes('/repos/tanaabased/example/issues/7'));
    assert.ok(requests[0]?.some((value) => value.includes('databaseId:.id')));
  });

  it('should constrain discovery to one configured assignment type', async () => {
    const requests: string[][] = [];
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_agent' },
      async execute(argv) {
        requests.push(argv);
        return response({ totalCount: 0, incomplete: false, items: [] });
      },
    });

    await client.discoverAssigned('2026-08-11T11:55:00.000Z', ['issue']);
    await client.discoverAssigned('2026-08-11T11:55:00.000Z', ['pull-request']);

    assert.ok(
      requests[0]?.includes(
        'q=assignee:tanaabot state:open updated:>=2026-08-11T11:55:00.000Z is:issue',
      ),
    );
    assert.ok(
      requests[1]?.includes(
        'q=assignee:tanaabot state:open updated:>=2026-08-11T11:55:00.000Z is:pr',
      ),
    );
  });

  it('should load canonical pull-request head and lifecycle facts separately', async () => {
    const requests: string[][] = [];
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_agent' },
      async execute(argv) {
        requests.push(argv);
        if (requests.length === 1) {
          return response({
            assignees: [{ login: 'tanaabot', nodeId: 'U_agent', type: 'User' }],
            databaseId: 43,
            isPullRequest: true,
            nodeId: 'PR_item',
            number: 8,
            state: 'open',
            updatedAt: '2026-08-14T12:00:00Z',
          });
        }
        return response({
          author: { login: 'pirog', nodeId: 'U_author', type: 'User' },
          base: { ref: 'main', repository: { databaseId: 3, nodeId: 'R_repo' } },
          draft: false,
          head: {
            ref: 'notification-pr',
            repository: { databaseId: 4, nodeId: 'R_fork' },
            sha: 'a'.repeat(40),
          },
          merged: false,
        });
      },
    });

    const item = await client.getItem('tanaabased', 'example', 8);

    assert.equal(item.itemType, 'pull-request');
    assert.deepEqual(item.itemType === 'pull-request' ? item.pullRequest : undefined, {
      author: { login: 'pirog', nodeId: 'U_author', type: 'User' },
      baseRef: 'main',
      baseRepositoryDatabaseId: 3,
      baseRepositoryNodeId: 'R_repo',
      draft: false,
      headRef: 'notification-pr',
      headRepositoryDatabaseId: 4,
      headRepositoryNodeId: 'R_fork',
      headSha: 'a'.repeat(40),
      merged: false,
    });
    assert.ok(requests[0]?.includes('/repos/tanaabased/example/issues/8'));
    assert.ok(requests[1]?.includes('/repos/tanaabased/example/pulls/8'));
    assert.ok(requests[1]?.some((value) => value.includes('sha:.head.sha')));
  });

  for (const kind of ['assigned', 'unassigned'] as const) {
    it(`should map ${kind} authority from the github assigner`, async () => {
      const requests: string[][] = [];
      const client = new GitHubWorkEventClient({
        identity: { login: 'tanaabot', nodeId: 'U_agent' },
        async execute(argv) {
          requests.push(argv);
          return response([
            {
              actor: { login: 'pirog', nodeId: 'U_assigner', type: 'User' },
              assignee: { login: 'tanaabot', nodeId: 'U_agent', type: 'User' },
              createdAt: '2026-08-11T12:05:00Z',
              databaseId: 8,
              event: kind,
              nodeId: 'EV_assign',
            },
          ]);
        },
      });

      const page = await client.listAssignmentEvents('tanaabased', 'example', 7);

      assert.deepEqual(page.events[0]?.actor, {
        login: 'pirog',
        nodeId: 'U_assigner',
        type: 'User',
      });
      const projection =
        requests[0]?.find((value) => value.includes('createdAt:.created_at')) ?? '';
      assert.match(projection, /actor:\{login:\.assigner\.login/u);
      assert.doesNotMatch(projection, /actor:\{login:\.actor\.login/u);
    });
  }

  for (const actor of [
    null,
    { login: 'approved', type: 'User' },
    { nodeId: 'U_approved', type: 'User' },
  ]) {
    it('should reject unassignment evidence without a complete responsible actor', async () => {
      const client = new GitHubWorkEventClient({
        identity: { login: 'tanaabot', nodeId: 'U_agent' },
        async execute() {
          return response([
            {
              actor,
              assignee: { login: 'tanaabot', nodeId: 'U_agent', type: 'User' },
              createdAt: '2026-08-11T12:05:00Z',
              databaseId: 8,
              event: 'unassigned',
              nodeId: 'EV_unassign',
            },
          ]);
        },
      });
      await assert.rejects(
        client.listAssignmentEvents('tanaabased', 'example', 7),
        /assignment actor/,
      );
    });
  }

  it('should fetch bounded issue context with the newest comment page', async () => {
    const requests: string[][] = [];
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_agent' },
      async execute(argv) {
        requests.push(argv);
        if (requests.length === 1) {
          return response({
            body: 'Please add the thing.',
            commentCount: 51,
            labels: ['feature'],
            title: 'Implement the thing',
          });
        }
        if (requests.length === 2) {
          return response(
            Array.from({ length: 50 }, (_, index) => ({
              authorLogin: 'pirog',
              body: `Earlier comment ${index + 1}.`,
              createdAt: '2026-08-11T12:04:00Z',
            })),
            '<https://api.github.com/repos/tanaabased/example/issues/7/comments?page=2>; rel="next"',
          );
        }
        return response([
          {
            authorLogin: 'pirog',
            body: 'The latest requirement.',
            createdAt: '2026-08-11T12:05:00Z',
          },
        ]);
      },
    });

    const context = await client.getItemContext('tanaabased', 'example', 7);

    assert.equal(context.title, 'Implement the thing');
    assert.equal(context.truncated, true);
    assert.equal(context.comments.length, 50);
    assert.equal(context.comments[0]?.body, 'Earlier comment 2.');
    assert.equal(context.comments.at(-1)?.body, 'The latest requirement.');
    assert.ok(requests[1]?.includes('page=1'));
    assert.ok(requests[2]?.includes('page=2'));
  });

  it('should include bounded pull-request file summaries without patches', async () => {
    const requests: string[][] = [];
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_agent' },
      async execute(argv) {
        requests.push(argv);
        if (requests.length === 1) {
          return response({
            body: 'Please review the pull request.',
            commentCount: 0,
            labels: ['review'],
            title: 'Update notifications',
          });
        }
        return response(
          [
            {
              additions: 12,
              changes: 15,
              deletions: 3,
              filename: 'channels/github/intake/monitor/poller.ts',
              previousFilename: null,
              status: 'modified',
            },
          ],
          '<https://api.github.com/repos/tanaabased/example/pulls/8/files?page=2>; rel="next"',
        );
      },
    });

    const context = await client.getItemContext('tanaabased', 'example', 8, 'pull-request');

    assert.equal(context.truncated, true);
    assert.deepEqual(context.files, [
      {
        additions: 12,
        changes: 15,
        deletions: 3,
        filename: 'channels/github/intake/monitor/poller.ts',
        status: 'modified',
      },
    ]);
    assert.ok(requests[1]?.includes('/repos/tanaabased/example/pulls/8/files'));
    assert.ok(requests[1]?.every((value) => !value.includes('patch')));
  });

  it('should list and re-read bounded canonical issue comments', async () => {
    const maximumCommentCharacters = 12_000;
    const requests: string[][] = [];
    const canonical = {
      author: { login: 'pirog', nodeId: 'U_actor', type: 'User' },
      body: '@tanaabot status?',
      bodyLength: 18,
      createdAt: '2026-08-14T12:00:00Z',
      databaseId: 91,
      nodeId: 'IC_comment',
      updatedAt: '2026-08-14T12:01:00Z',
    };
    const client = new GitHubWorkEventClient(
      {
        identity: { login: 'tanaabot', nodeId: 'U_agent' },
        async execute(argv) {
          requests.push(argv);
          return argv.includes('/repos/tanaabased/example/issues/comments/91')
            ? response({
                ...canonical,
                issueUrl: 'https://api.github.com/repos/tanaabased/example/issues/7',
              })
            : response([canonical]);
        },
      },
      maximumCommentCharacters,
    );

    const page = await client.listIssueComments('tanaabased', 'example', 7);
    const exact = await client.getIssueComment('tanaabased', 'example', 7, 91);

    assert.equal(page.truncated, false);
    assert.equal(page.comments[0]?.author?.nodeId, 'U_actor');
    assert.equal(exact.nodeId, 'IC_comment');
    assert.ok(requests[0]?.includes(`per_page=${githubCommentPageSize(maximumCommentCharacters)}`));
    assert.ok(requests[0]?.some((value) => value.includes('[0:12001]')));
    assert.ok(requests[1]?.some((value) => value.includes('[0:12001]')));
  });

  for (const intent of ['pull-request-handoff', 'assessment-summary'] as const) {
    it(`should reconcile and publish ${intent} without putting bodies in argv`, async () => {
      const publicationMarker = githubNotificationPublicationMarker(
        githubNotificationPublicationTarget({
          intent,
          publicationId: 'retained-publication',
          item: {
            lifecycleId: 'issue',
            number: 7,
            repositoryNodeId: 'R_example',
          },
        }),
      );
      const body = `On it.\n\n${publicationMarker}`;
      const requests: Array<{ argv: string[]; stdin?: string }> = [];
      const client = new GitHubWorkEventClient({
        identity: { login: 'tanaabot', nodeId: 'U_agent' },
        async execute(argv, stdin) {
          requests.push({ argv, ...(stdin === undefined ? {} : { stdin }) });
          if (argv.includes('POST')) {
            return response({
              body,
              databaseId: 91,
              nodeId: 'IC_published',
              user: { login: 'tanaabot', nodeId: 'U_agent', type: 'User' },
            });
          }
          return response([
            {
              body,
              databaseId: 90,
              nodeId: 'IC_existing',
              user: { login: 'tanaabot', nodeId: 'U_agent', type: 'User' },
            },
          ]);
        },
      });

      assert.deepEqual(
        await client.findOwnIssueComment('tanaabased', 'example', 7, publicationMarker),
        { body, databaseId: 90, nodeId: 'IC_existing' },
      );
      assert.deepEqual(await client.createIssueComment('tanaabased', 'example', 7, body), {
        databaseId: 91,
        nodeId: 'IC_published',
      });
      assert.equal(requests[1]?.stdin, JSON.stringify({ body }));
      assert.equal(requests[1]?.argv.includes(body), false);
      for (const marker of [
        publicationMarker.replace(intent, 'unknown-intent'),
        publicationMarker.replace(/:[a-f0-9]{32}/u, ':bad-digest'),
      ]) {
        await assert.rejects(
          client.findOwnIssueComment('tanaabased', 'example', 7, marker),
          /publication markers are invalid/u,
        );
      }
      assert.equal(requests.length, 2);
    });
  }
});
