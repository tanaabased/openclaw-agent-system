import assert from 'node:assert/strict';
import GitHubProjectPickupClient from '../channels/github/provider/project-pickup-client.ts';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import retryGitHubRead from '../core/github-read-retry.ts';

function fixture() {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const reply = { value: [] as unknown, status: 200, next: false };
  const api = new GitHubWorkEventApiClient(
    {
      identity: { login: 'receiver', nodeId: 'U_receiver' },
      async execute(argv, stdin) {
        calls.push({ argv, stdin });
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

describe('github project pickup provider', () => {
  it('should preserve milestone page scope and provider continuation', async () => {
    const f = fixture();
    f.reply.value = [{ nodeId: 'I_one', number: 1, title: 'ready', body: '', labels: [] }];
    f.reply.next = true;
    assert.equal((await f.client.discoverProject('owner', 'repo', 4, 2)).nextPage, 3);
    const argv = f.calls[0]!.argv;
    for (const part of ['/repos/owner/repo/issues', 'milestone=4', 'state=open', 'page=2'])
      assert.ok(argv.includes(part));
    f.reply.value = [{ nodeId: 'bad' }];
    await assert.rejects(f.client.discoverProject('owner', 'repo', 4, 3), /candidates-invalid/);
  });

  it('should require complete closed dependencies to establish readiness', async () => {
    const f = fixture();
    f.reply.value = ['closed'];
    assert.equal(await f.client.projectBlocked('owner', 'repo', 1), false);
    f.reply.value = ['open'];
    assert.equal(await f.client.projectBlocked('owner', 'repo', 1), true);
    f.reply.value = ['closed'];
    f.reply.next = true;
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
