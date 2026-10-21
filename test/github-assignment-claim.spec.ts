import assert from 'node:assert/strict';

import type { ClaimSource } from '../agent/assignment-claim.ts';
import GitHubAssignmentClaimClient from '../channels/github/provider/assignment-claim-client.ts';
import { claimBody, parseAssignmentClaim } from '../channels/github/provider/assignment-claim.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import GitHubWorkEventClient from '../channels/github/provider/work-event-client.ts';

describe('channels/github/provider/assignment-claim', () => {
  const metadata = {
    instanceId: '97ceda94-0cd5-4c2f-8bb5-17a0171f12b9',
    assignmentEventId: 'AE_fixture',
  };
  const comment = (body: string) => ({ body, bodyTruncated: false }) as GitHubCanonicalIssueComment;
  it('should recognize exact registered and accepted metadata without trusting quoted markers', () => {
    for (const accepted of [true, false]) {
      const body = claimBody(metadata, 'copper-otter', accepted);
      assert.deepEqual(parseAssignmentClaim(comment(body)), metadata);
      for (const invalid of [
        `> ${body}`,
        `\`\`\`\n${body}\n\`\`\``,
        `${body}\n${body}`,
        body.replace('claim:v1', 'claim:v2'),
        body.replace('"instanceId"', '"author"'),
        body.replace('"assignmentEventId":', '"extra":true,"assignmentEventId":'),
      ])
        assert.equal(parseAssignmentClaim(comment(invalid)), undefined);
      assert.equal(parseAssignmentClaim({ ...comment(body), bodyTruncated: true }), undefined);
    }
  });
  it('should accept an empty successful delete response without weakening malformed json checks', async () => {
    const client = (status: number) =>
      new GitHubWorkEventApiClient({
        identity: { nodeId: 'U_fixture', login: 'fixture' },
        async execute() {
          return {
            exitCode: 0,
            stderr: '',
            stdout: `HTTP/2 ${status}\n\n`,
            timedOut: false,
            truncated: false,
          };
        },
      });
    assert.equal((await client(204).request(['--method', 'DELETE'], 'cleanup')).value, null);
    await assert.rejects(client(200).request([], 'read'));
  });
  const source: ClaimSource = {
    owner: 'owner',
    repository: 'repo',
    number: 1,
    repositoryNodeId: 'R_fixture',
    issueNodeId: 'I_fixture',
    receivingNodeId: 'U_fixture',
    assignmentEventId: 'AE_fixture',
    assignerNodeId: 'U_operator',
  };
  const projected = (databaseId: number, author = 'U_fixture', body = 'claim') => ({
    databaseId,
    nodeId: `IC_${databaseId}`,
    author: { login: 'fixture', nodeId: author, type: 'User' },
    body,
    bodyLength: body.length,
    issueUrl: 'https://api.github.com/repos/owner/repo/issues/1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  const port = (respond: (argv: string[]) => { value: unknown; next?: boolean; status?: number }) =>
    new GitHubAssignmentClaimClient(
      new GitHubWorkEventClient({
        identity: { login: 'fixture', nodeId: 'U_fixture' },
        async execute(argv) {
          const reply = respond(argv);
          return {
            exitCode: 0,
            stderr: '',
            timedOut: false,
            truncated: false,
            stdout: `HTTP/2 ${reply.status ?? 200}\n${reply.next ? 'link: <https://api.github.com/page2>; rel="next"\n' : ''}\n${reply.status === 204 ? '' : JSON.stringify(reply.value)}`,
          };
        },
      }),
    );
  it('should read later comment pages and reject incomplete listings', async () => {
    const pages: string[] = [];
    const client = port((argv) => {
      const page = argv.find((arg) => arg.startsWith('page='))!;
      pages.push(page);
      return { value: [projected(pages.length)], next: pages.length < 3 };
    });
    assert.deepEqual(
      (await client.list(source)).map((item) => item.databaseId),
      [1, 2, 3],
    );
    assert.deepEqual(pages, ['page=1', 'page=2', 'page=3']);
    await assert.rejects(
      port(() => ({ value: [], next: true })).list(source),
      /claim-comments-incomplete/u,
    );
  });
  it('should refuse changed or foreign comments before cleanup and confirm updates by reading back', async () => {
    for (const current of [projected(1, 'U_foreign'), projected(1, 'U_fixture', 'edited')]) {
      const client = port((argv) => {
        assert.ok(!argv.includes('DELETE'));
        return { value: current };
      });
      client.verify = async () => {};
      await assert.rejects(client.remove(source, 1, 'claim'), /claim-comment-changed/u);
    }
    let patched = false;
    const client = port((argv) => {
      if (argv.includes('PATCH')) patched = true;
      return { value: projected(1) };
    });
    client.verify = async () => {};
    await assert.rejects(
      client.update(source, 1, 'claim', 'accepted'),
      /claim-update-unconfirmed/u,
    );
    assert.equal(patched, true);
    await assert.rejects(
      port(() => {
        throw new Error('unexpected request');
      }).verify({ ...source, receivingNodeId: 'U_foreign' }),
      /claim-receiving-account-mismatch/u,
    );
  });
});
