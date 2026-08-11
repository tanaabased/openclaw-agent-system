import assert from 'node:assert/strict';

import type { AgentSystemCliResult } from '../lib/tool-types.ts';
import GitHubWorkEventClient from '../channels/github/lib/work-event-client.ts';

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
      requests.every((argv) => argv.some((value) => value.startsWith('q=assignee:tanaabot'))),
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
});
