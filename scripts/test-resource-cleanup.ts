import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const project = 'tanaabased/openclaw-agent-system';
const bucket = 'tanaabased/big-test-bucket';
const workflows = ['os', 'codex', 'openclaw', 'notifications'].map(
  (name) => `.github/workflows/pr-examples-${name}.yml`,
);
type Account = 'actions' | 'tanaabot' | 'emoriwan';
type ObjectValue = Record<string, unknown>;
export type TestResourceApi = (
  account: Account,
  method: 'GET' | 'PATCH' | 'DELETE' | 'POST',
  route: string,
  body?: ObjectValue,
) => Promise<unknown>;
export class TestResourceProviderError extends Error {
  constructor(readonly status: number) {
    super(`github-http-${status}`);
  }
}
function object(value: unknown): ObjectValue {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'invalid-github-response');
  return value as ObjectValue;
}
export function testResourcePrefix(repositoryId: number, runId: number, attempt: number) {
  assert.ok(
    [repositoryId, runId, attempt].every((value) => Number.isSafeInteger(value) && value > 0),
    'positive-source-identifiers-required',
  );
  return `agent-system-test-${repositoryId}-${runId}-${attempt}-`;
}

/** Re-read provider state on every invocation; no runner-local state is needed for retries. */
export default async function cleanupTestResources(input: {
  repositoryId: number;
  runId: number;
  attempt: number;
  api: TestResourceApi;
}) {
  const { api, runId, attempt } = input;
  const prefix = testResourcePrefix(input.repositoryId, runId, attempt);
  const run = object(
    await api('actions', 'GET', `repos/${project}/actions/runs/${runId}/attempts/${attempt}`),
  );
  assert.ok(
    run.id === runId &&
      run.run_attempt === attempt &&
      run.status === 'completed' &&
      workflows.includes(String(run.path)) &&
      object(run.repository).id === input.repositoryId &&
      object(run.repository).full_name === project &&
      object(run.head_repository).id === input.repositoryId &&
      typeof run.run_started_at === 'string' &&
      Number.isFinite(Date.parse(run.run_started_at)),
    'source-attempt-must-be-completed-and-owned',
  );
  const outcomes: Array<{ resource: string; target: string; result: string }> = [];
  const done = (resource: string, target: string, result: string) =>
    outcomes.push({ resource, target, result });
  const attemptCleanup = async (resource: string, target: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      done(resource, target, error instanceof TestResourceProviderError ? error.message : 'failed');
    }
  };
  const identify = async (account: 'tanaabot' | 'emoriwan') => {
    assert.equal(
      object(await api(account, 'GET', 'user')).login,
      account,
      'cleanup-account-mismatch',
    );
  };
  const list = async (account: Account, route: string, before?: string) => {
    const result: ObjectValue[] = [];
    for (let page = 1; ; page++) {
      const values = await api(
        account,
        'GET',
        `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      assert.ok(Array.isArray(values), 'invalid-github-list');
      const entries = values.map(object);
      result.push(...entries);
      if (
        entries.length < 100 ||
        (before && entries.some((entry) => String(entry.created_at) < before))
      )
        return result;
    }
  };
  const remove = async (account: Account, route: string) => {
    try {
      await api(account, 'DELETE', route);
    } catch (error) {
      if (!(error instanceof TestResourceProviderError && error.status === 404)) throw error;
    }
  };

  for (const collection of ['keys', 'ssh_signing_keys']) {
    await attemptCleanup(collection, 'tanaabot', async () => {
      await identify('tanaabot');
      const keys = await list('tanaabot', `user/${collection}`);
      for (const key of keys.filter((key) => String(key.title).startsWith(prefix))) {
        await attemptCleanup(collection, String(key.id), async () => {
          assert.ok(Number.isSafeInteger(key.id), 'invalid-key-id');
          await remove('tanaabot', `user/${collection}/${key.id}`);
          done(collection, String(key.id), 'removed');
        });
      }
    });
  }

  let issues: ObjectValue[] = [];
  let defaultBranch = 'main';
  await attemptCleanup('issues', bucket, async () => {
    await identify('emoriwan');
    const repository = object(await api('emoriwan', 'GET', `repos/${bucket}`));
    assert.ok(
      repository.id === 1329940218 && repository.full_name === bucket,
      'cleanup-repository-mismatch',
    );
    assert.equal(typeof repository.default_branch, 'string', 'missing-default-branch');
    defaultBranch = String(repository.default_branch);
    issues = (
      await list(
        'emoriwan',
        `repos/${bucket}/issues?state=all&since=${encodeURIComponent(String(run.run_started_at))}`,
      )
    ).filter(
      (issue) =>
        !issue.pull_request &&
        String(issue.title).startsWith(prefix) &&
        ['emoriwan', 'tanaabot'].includes(String(object(issue.user).login)),
    );
  });
  if (issues.length) {
    await attemptCleanup('pull-requests', bucket, async () => {
      await identify('tanaabot');
      const pulls = await list(
        'tanaabot',
        `repos/${bucket}/pulls?state=all&sort=created&direction=desc`,
        String(run.run_started_at),
      );
      for (const pull of pulls) {
        const pullHead = object(pull.head);
        if (
          String(pull.created_at) < String(run.run_started_at) ||
          object(pull.user).login !== 'tanaabot' ||
          !pullHead.repo ||
          object(pullHead.repo).id !== 1329940218
        )
          continue;
        await attemptCleanup('pull-request', String(pull.number), async () => {
          const linked = object(
            await api('tanaabot', 'POST', 'graphql', {
              query:
                'query($id:ID!){node(id:$id){... on PullRequest{closingIssuesReferences(first:100){nodes{id} pageInfo{hasNextPage}}}}}',
              variables: { id: pull.node_id },
            }),
          );
          const references = object(object(object(linked.data).node).closingIssuesReferences);
          assert.ok(
            !object(references.pageInfo).hasNextPage && Array.isArray(references.nodes),
            'incomplete-closing-issues',
          );
          if (
            !references.nodes.some((node) =>
              issues.some((issue) => issue.node_id === object(node).id),
            )
          )
            return;
          if (pull.state !== 'closed')
            await api('tanaabot', 'PATCH', `repos/${bucket}/pulls/${pull.number}`, {
              state: 'closed',
            });
          done('pull-request', String(pull.number), 'closed');
          const head = object(pull.head);
          assert.ok(
            typeof head.ref === 'string' && ![defaultBranch, 'main', 'master'].includes(head.ref),
            'protected-branch',
          );
          await remove(
            'tanaabot',
            `repos/${bucket}/git/refs/heads/${encodeURIComponent(head.ref)}`,
          );
          done('branch', head.ref, 'removed');
        });
      }
    });
    for (const issue of issues) {
      await attemptCleanup('issue', String(issue.number), async () => {
        if (issue.state !== 'closed')
          await api('emoriwan', 'PATCH', `repos/${bucket}/issues/${issue.number}`, {
            state: 'closed',
          });
        done('issue', String(issue.number), 'closed');
      });
    }
  }
  return {
    runId,
    attempt,
    prefix,
    outcomes,
    ok: outcomes.every(({ result }) => ['removed', 'closed'].includes(result)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'github-actions-only');
    assert.equal(process.env.GITHUB_REPOSITORY, project, 'cleanup-project-mismatch');
    const report = await cleanupTestResources({
      repositoryId: Number(process.env.GITHUB_REPOSITORY_ID),
      runId: Number(process.env.TEST_SOURCE_RUN),
      attempt: Number(process.env.TEST_SOURCE_ATTEMPT),
      api: async (account, method, route, body) => {
        const token =
          process.env[
            account === 'actions'
              ? 'GITHUB_TOKEN'
              : account === 'tanaabot'
                ? 'GH_TOKEN_TANAABOT'
                : 'GH_TOKEN_EMORI'
          ];
        assert.ok(token, 'cleanup-token-missing');
        const response = await fetch(`https://api.github.com/${route}`, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) throw new TestResourceProviderError(response.status);
        const value: unknown = response.status === 204 ? null : await response.json();
        if (value && typeof value === 'object' && 'errors' in value)
          throw new Error('github-graphql-failed');
        return value;
      },
    });
    const summary = JSON.stringify(report, null, 2);
    process.stdout.write(`${summary}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `### Test resource cleanup\n\n\`\`\`json\n${summary}\n\`\`\`\n`,
      );
    if (!report.ok) process.exitCode = 1;
  } catch {
    process.stderr.write(
      'Test resource cleanup failed; source attempt or provider access could not be verified.\n',
    );
    process.exitCode = 1;
  }
}
