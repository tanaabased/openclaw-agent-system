import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import GitHubProjectPickupClient, {
  projectCandidateSchema,
} from '../channels/github/provider/project-pickup-client.ts';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import retryGitHubRead from '../core/github-read-retry.ts';

function fixture() {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const reply = {
    value: [] as unknown,
    status: 200,
    next: false,
    pages: [] as Array<{ value: unknown; next: boolean }>,
  };
  const api = new GitHubWorkEventApiClient(
    {
      identity: { login: 'receiver', nodeId: 'U_receiver' },
      async execute(argv, stdin) {
        calls.push({ argv, stdin });
        const page = reply.pages.shift();
        if (page) Object.assign(reply, page);
        return {
          exitCode: reply.status >= 400 ? 1 : 0,
          timedOut: false,
          truncated: false,
          stderr: '',
          stdout: `HTTP/2 ${reply.status} Response\netag: "pickup"\n${reply.next ? 'link: <https://api.github.com/next>; rel="next"\n' : ''}\n${JSON.stringify(reply.value)}`,
        };
      },
    },
    (read, options) => retryGitHubRead(read, { ...options, sleep: async () => undefined }),
  );
  return { calls, reply, client: new GitHubProjectPickupClient(api) };
}

function observation(candidate: Record<string, unknown>) {
  return {
    item: {
      databaseId: 1,
      nodeId: candidate.nodeId,
      number: candidate.number,
      state: 'open',
      updatedAt: '2026-11-03T03:00:00Z',
      title: candidate.title,
      isPullRequest: false,
      assignees: [],
      milestone: { node_id: 'M_pilot', number: 4, state: 'open' },
    },
    candidate,
  };
}

describe('github project pickup provider', () => {
  it('should keep complete descriptions and reject malformed provider data', async () => {
    const f = fixture();
    const candidate = {
      nodeId: 'I_one',
      number: 1,
      title: 'ready',
      body: 'a'.repeat(32000),
      labels: [],
    };
    f.reply.value = observation(candidate);
    const result = await f.client.projectCandidate('owner', 'repo', 1);
    assert.deepEqual(result.candidate, candidate);
    assert.equal(result.item.itemType, 'issue');
    assert.equal(result.item.state, 'open');
    assert.deepEqual(result.item.assignees, []);
    assert.equal(f.calls.length, 1);
    f.reply.value = observation({ ...candidate, body: 42 });
    await assert.rejects(f.client.projectCandidate('owner', 'repo', 1), /candidate-invalid/);
  });

  for (const character of ['a', '🦊']) {
    it(`should retain complete large descriptions containing ${character}`, async () => {
      const f = fixture();
      const body = character.repeat(64000);
      f.reply.value = observation({ nodeId: 'I_one', number: 1, title: 'ready', body, labels: [] });
      const { candidate } = await f.client.projectCandidate('owner', 'repo', 1);
      assert.equal(candidate.body, body);
      assert.equal(Object.hasOwn(candidate, 'bodyTruncated'), false);
      assert.ok(Value.Check(projectCandidateSchema, candidate));
      f.reply.value = observation({ ...candidate, body: `${character.repeat(63999)}b` });
      const changed = await f.client.projectCandidate('owner', 'repo', 1);
      assert.notEqual(changed.candidate.body, candidate.body);
    });
  }

  it('should preserve milestone page scope and provider continuation', async () => {
    const f = fixture();
    f.reply.value = [{ nodeId: 'I_one', number: 1 }];
    f.reply.next = true;
    assert.equal((await f.client.discoverProject('owner', 'repo', 4, 2)).nextPage, 3);
    const argv = f.calls[0]!.argv;
    for (const part of ['/repos/owner/repo/issues', 'milestone=4', 'state=open', 'page=2'])
      assert.ok(argv.includes(part));
    f.reply.value = [{ nodeId: 'bad' }];
    await assert.rejects(f.client.discoverProject('owner', 'repo', 4, 3), /candidates-invalid/);
  });

  it('should discover repository-wide issues without a milestone parameter', async () => {
    const f = fixture();
    f.reply.value = [{ nodeId: 'I_one', number: 1 }];
    f.reply.next = true;
    assert.deepEqual(await f.client.discoverProject('owner', 'repo', undefined, 1), {
      candidates: [{ nodeId: 'I_one', number: 1 }],
      nextPage: 2,
    });
    assert.equal(
      f.calls[0]!.argv.some((part) => part.startsWith('milestone=')),
      false,
    );
    assert.ok(f.calls[0]!.argv.includes('state=open'));
    await assert.rejects(f.client.discoverProject('owner', 'repo', 0, 1), /page-invalid/);
  });

  it('should require complete closed dependencies to establish readiness', async () => {
    const f = fixture();
    f.reply.value = ['closed'];
    assert.equal(await f.client.projectBlocked('owner', 'repo', 1), false);
    f.reply.value = ['open'];
    assert.equal(await f.client.projectBlocked('owner', 'repo', 1), true);
    f.reply.value = ['closed'];
    f.reply.pages = [
      { value: ['closed'], next: true },
      { value: ['closed'], next: false },
    ];
    assert.equal(await f.client.projectBlocked('owner', 'repo', 1), false);
    assert.ok(f.calls.at(-1)!.argv.includes('page=2'));
    f.reply.pages = [
      { value: ['closed'], next: true },
      { value: ['open'], next: false },
    ];
    assert.equal(await f.client.projectBlocked('owner', 'repo', 1), true);
    f.reply.value = ['unknown'];
    await assert.rejects(f.client.projectBlocked('owner', 'repo', 1), /dependencies-invalid/);
  });

  it('should add only the authenticated assignee without replaying an uncertain mutation', async () => {
    const f = fixture();
    f.reply.status = 502;
    await assert.rejects(f.client.assignProjectIssue('owner', 'repo', 1));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(JSON.parse(f.calls[0]!.stdin!), { assignees: ['receiver'] });
    assert.ok(f.calls[0]!.argv.includes('POST'));
    assert.ok(f.calls[0]!.argv.includes('/repos/owner/repo/issues/1/assignees'));
  });
});
