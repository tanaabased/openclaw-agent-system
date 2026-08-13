import assert from 'node:assert/strict';

import type { AgentSystemCliResult } from '../lib/tool-types.ts';
import GitHubWorkEventClient from '../channels/github/lib/work-event-client.ts';
import { githubAssignmentAcknowledgmentMarker } from '../channels/github/utils/acknowledgment.ts';

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

describe('channels/github/lib/work-event-client', () => {
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

    const discovery = await client.discoverAssigned('2026-08-11T11:55:00.000Z');

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
          updatedAt: '2026-08-11T12:00:00Z',
        });
      },
    });

    const item = await client.getItem('tanaabased', 'example', 7);

    assert.equal(item.databaseId, 42);
    assert.ok(requests[0]?.includes('/repos/tanaabased/example/issues/7'));
    assert.ok(requests[0]?.some((value) => value.includes('databaseId:.id')));
  });

  it('should map assignment authority from the github assigner', async () => {
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
            event: 'assigned',
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
    const projection = requests[0]?.find((value) => value.includes('createdAt:.created_at')) ?? '';
    assert.match(projection, /actor:\{login:\.assigner\.login/u);
    assert.doesNotMatch(projection, /actor:\{login:\.actor\.login/u);
  });

  it('should reconcile and publish an exact marked comment without putting its body in argv', async () => {
    const marker = githubAssignmentAcknowledgmentMarker('EV_assignment');
    const body = `On it.\n\n${marker}`;
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
        return response([]);
      },
    });

    assert.equal(await client.findOwnIssueComment('tanaabased', 'example', 7, marker), undefined);
    assert.deepEqual(await client.createIssueComment('tanaabased', 'example', 7, body), {
      databaseId: 91,
      nodeId: 'IC_published',
    });
    assert.equal(requests[1]?.stdin, JSON.stringify({ body }));
    assert.equal(requests[1]?.argv.includes(body), false);
    assert.ok(requests[1]?.argv.includes('--input'));
  });

  it('should adopt only the authenticated account marker receipt', async () => {
    const marker = githubAssignmentAcknowledgmentMarker('EV_assignment');
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_agent' },
      async execute() {
        return response([
          {
            databaseId: 90,
            nodeId: 'IC_other',
            user: { login: 'someone', nodeId: 'U_other', type: 'User' },
          },
          {
            databaseId: 91,
            nodeId: 'IC_own',
            user: { login: 'tanaabot', nodeId: 'U_agent', type: 'User' },
          },
        ]);
      },
    });

    assert.deepEqual(await client.findOwnIssueComment('tanaabased', 'example', 7, marker), {
      databaseId: 91,
      nodeId: 'IC_own',
    });
  });
});
